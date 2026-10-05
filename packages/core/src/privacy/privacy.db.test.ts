import type { Order } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { changeOrderStatus } from '../orders/change-status'
import { importOrder } from '../orders/import'
import { getOrder, listOrders } from '../orders/queries'
import { createTestOrganization, type TestContext } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, createTestConnection, fact, user } from '../testing/fixtures'
import { eraseBuyerData, previewBuyerErasure } from './erasure'
import { getPrivacySettings, setBuyerDataRetention } from './settings'
import { applyBuyerDataRetention, sealLegacyBuyerData, sweepBuyerData } from './sweep'

const DAY = 86_400_000

/** The raw row as Postgres stores it, every column as text. */
async function rawRow(ctx: TestContext, orderId: string): Promise<string> {
  const [row] = await ctx.db.$queryRaw<Array<{ row: unknown }>>`SELECT row_to_json(o) AS "row" FROM "order" o WHERE "id" = ${orderId}`
  return JSON.stringify(row?.row)
}

/** Rewrites an Order into the shape written before ADR 0011. */
async function makeLegacy(ctx: TestContext, orderId: string, order: Order): Promise<void> {
  await ctx.db.$executeRaw`
    UPDATE "order" SET "buyerData" = NULL, "buyerEmailIndex" = NULL, "shippingCountryCode" = NULL,
      "buyerName" = ${order.buyer.name}, "buyerEmail" = ${order.buyer.email}, "buyerPhone" = ${order.buyer.phone},
      "buyerLogin" = ${order.buyer.login}, "shippingAddress" = ${JSON.stringify(order.shippingAddress)}::jsonb,
      "billingAddress" = ${order.billingAddress === null ? null : JSON.stringify(order.billingAddress)}::jsonb
    WHERE "id" = ${orderId}`
}

async function closeDaysAgo(ctx: TestContext, orderId: string, days: number, now = new Date()): Promise<void> {
  await ctx.db.order.update({ where: { id: orderId }, data: { status: 'shipped', closedAt: new Date(now.getTime() - days * DAY) } })
}

function buyer(email: string | null, name = 'Anna Nowak'): Pick<Order, 'buyer' | 'shippingAddress'> {
  return {
    buyer: { name, email, phone: '+48 600 100 200', login: null },
    shippingAddress: {
      name,
      company: null,
      street: 'ul. Prywatna 7',
      postalCode: '00-950',
      city: 'Warszawa',
      countryCode: 'PL',
      phone: null,
      taxId: null,
    },
  }
}

describe.skipIf(!databaseUrl)('Buyer data privacy', () => {
  const context = useTestContext()

  async function setup() {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const connectionId = await createTestConnection(ctx, org)
    const importOne = async (overrides: Partial<Order> = {}) => {
      const order = buildOrder(overrides)
      return { order, orderId: (await importOrder(ctx, org, connectionId, order)).orderId }
    }
    return { ctx, org, connectionId, importOne }
  }

  it('stores no plaintext Buyer data and returns it decrypted to the panel', async () => {
    const { ctx, org, importOne } = await setup()
    const { order, orderId } = await importOne({
      ...buyer('anna.nowak@example.com'),
      billingAddress: { ...buyer(null).shippingAddress, company: 'Nowak Sp. z o.o.', taxId: '5250001009' },
    })

    const raw = await rawRow(ctx, orderId)
    for (const personal of ['Anna', 'Nowak', 'anna.nowak', '600 100 200', 'Prywatna', 'Warszawa', '5250001009']) {
      expect(raw).not.toContain(personal)
    }
    expect(raw).toContain('"shippingCountryCode":"PL"')

    const detail = await getOrder(ctx, org, orderId)
    expect(detail).toMatchObject({
      buyer: order.buyer,
      shippingAddress: order.shippingAddress,
      billingAddress: order.billingAddress,
      shippingCountryCode: 'PL',
      buyerDataErasedAt: null,
    })
    expect((await listOrders(ctx, org, { skip: 0, take: 10 })).items[0]).toMatchObject({ buyerName: 'Anna Nowak', buyerDataErasedAt: null })
  })

  it('a sealed value moved to another Order does not open', async () => {
    const { ctx, org, importOne } = await setup()
    const first = await importOne()
    const second = await importOne()
    const { buyerData } = await ctx.db.order.findFirstOrThrow({ where: { id: first.orderId } })
    await ctx.db.order.update({ where: { id: second.orderId }, data: { buyerData } })
    await expect(getOrder(ctx, org, second.orderId)).rejects.toThrow()
  })

  it('records when an Order closed: by a person or by a Channel fact, not for open statuses', async () => {
    const { ctx, org, importOne } = await setup()
    const byPerson = await importOne()
    const processing = await importOne()
    const byFact = await importOne({ facts: [fact('f1', 'shipped')] })
    await changeOrderStatus(ctx, org, byPerson.orderId, 'cancelled', user)
    await changeOrderStatus(ctx, org, processing.orderId, 'processing', user)

    const closedAt = async (id: string) => (await ctx.db.order.findFirstOrThrow({ where: { id } })).closedAt
    expect(await closedAt(byPerson.orderId)).toBeInstanceOf(Date)
    expect(await closedAt(byFact.orderId)).toBeInstanceOf(Date)
    expect(await closedAt(processing.orderId)).toBeNull()
  })

  it('seals legacy plaintext rows, idempotently, and reads them in both shapes', async () => {
    const { ctx, org, importOne } = await setup()
    const legacy = await importOne(buyer('legacy@example.com', 'Lena Legacy'))
    const other = await importOne()
    await makeLegacy(ctx, legacy.orderId, legacy.order)
    expect(await rawRow(ctx, legacy.orderId)).toContain('Lena Legacy')
    expect((await getOrder(ctx, org, legacy.orderId))?.buyer).toEqual(legacy.order.buyer)
    const otherBefore = await ctx.db.order.findFirstOrThrow({ where: { id: other.orderId } })

    expect(await sealLegacyBuyerData(ctx, org)).toBe(1)
    expect(await sealLegacyBuyerData(ctx, org)).toBe(0)

    const raw = await rawRow(ctx, legacy.orderId)
    expect(raw).not.toContain('Lena')
    expect(raw).not.toContain('legacy@example.com')
    expect(raw).toContain('"shippingCountryCode":"PL"')
    expect(await getOrder(ctx, org, legacy.orderId)).toMatchObject({ buyer: legacy.order.buyer, shippingAddress: legacy.order.shippingAddress })
    // An Order sealed on import is left alone.
    expect((await ctx.db.order.findFirstOrThrow({ where: { id: other.orderId } })).buyerData).toBe(otherBefore.buyerData)
  })

  it('retention erases only Orders closed long enough ago, in its own organization, and only once', async () => {
    const { ctx, org, importOne } = await setup()
    const other = await setup()
    const now = new Date()
    const old = await importOne({ facts: [{ ...fact('f1', 'shipped'), note: 'Buyer Anna asked for a gift wrap' }] })
    const recent = await importOne()
    const open = await importOne({ placedAt: '2020-01-01T00:00:00Z' })
    const otherOld = await other.importOne()
    await closeDaysAgo(ctx, old.orderId, 40, now)
    await closeDaysAgo(ctx, recent.orderId, 10, now)
    await closeDaysAgo(ctx, otherOld.orderId, 400, now)

    expect(await applyBuyerDataRetention(ctx, org, now)).toBe(0)
    await setBuyerDataRetention(ctx, org, 30, user)
    expect(await getPrivacySettings(ctx, org)).toEqual({ buyerDataRetentionDays: 30 })

    expect(await sweepBuyerData(ctx, org, now)).toEqual({ sealed: 0, erased: 1, more: false })
    expect(await sweepBuyerData(ctx, org, now)).toEqual({ sealed: 0, erased: 0, more: false })

    const erased = await ctx.db.order.findFirstOrThrow({ where: { id: old.orderId }, include: { lines: true, facts: true } })
    expect(erased).toMatchObject({
      buyerData: null,
      buyerEmailIndex: null,
      buyerName: null,
      shippingAddress: null,
      shippingCountryCode: 'PL',
      status: 'shipped',
    })
    expect(erased.buyerDataErasedAt).toEqual(now)
    expect(erased.totalAmount.toFixed()).toBe('10')
    expect(erased.lines).toHaveLength(1)
    expect(erased.facts.map((row) => row.note)).toEqual([null])
    expect(await getOrder(ctx, org, old.orderId)).toMatchObject({ buyer: null, shippingAddress: null, buyerName: null, shippingCountryCode: 'PL' })

    for (const kept of [recent, open]) expect((await getOrder(ctx, org, kept.orderId))?.buyer).toEqual(kept.order.buyer)
    expect((await getOrder(ctx, other.org, otherOld.orderId))?.buyer).toEqual(otherOld.order.buyer)

    const events = await ctx.db.eventLog.findMany({ where: { organizationId: org, type: 'order.buyer_data_erased' } })
    expect(events.map((event) => [event.subjectId, event.payload])).toEqual([
      [old.orderId, { cause: 'retention', retentionDays: 30, actor: { type: 'system' } }],
    ])
    const settingEvents = await ctx.db.eventLog.findMany({ where: { organizationId: org, type: 'privacy.retention_changed' } })
    expect(settingEvents.map((event) => event.payload)).toEqual([{ from: null, to: 30, actor: user }])
  })

  it('refuses a retention outside 1-3650 days, and records nothing when it does not change', async () => {
    const { ctx, org } = await setup()
    for (const days of [0, -1, 3651, 1.5]) await expect(setBuyerDataRetention(ctx, org, days, user)).rejects.toThrow(RangeError)
    await setBuyerDataRetention(ctx, org, null, user)
    expect(await ctx.db.eventLog.count({ where: { organizationId: org, type: 'privacy.retention_changed' } })).toBe(0)
  })

  it('an erasure request erases exactly one person’s closed Orders in one organization and keeps the open ones', async () => {
    const { ctx, org, importOne } = await setup()
    const other = await setup()
    const closedA = await importOne(buyer('anna.nowak@example.com'))
    const closedB = await importOne(buyer('Anna.Nowak@Example.com '))
    const legacyClosed = await importOne(buyer('ANNA.NOWAK@example.com'))
    const open = await importOne(buyer('anna.nowak@example.com'))
    const someoneElse = await importOne(buyer('anna.nowak2@example.com', 'Anna Nowak'))
    const noEmail = await importOne(buyer(null))
    const otherTenant = await other.importOne(buyer('anna.nowak@example.com'))
    await makeLegacy(ctx, legacyClosed.orderId, legacyClosed.order)
    for (const { orderId } of [closedA, closedB, legacyClosed, someoneElse, noEmail]) await closeDaysAgo(ctx, orderId, 1)
    await closeDaysAgo(ctx, otherTenant.orderId, 1)

    expect(await previewBuyerErasure(ctx, org, ' anna.nowak@EXAMPLE.com')).toEqual({ closed: 3, open: 1 })
    expect(await eraseBuyerData(ctx, org, ' anna.nowak@EXAMPLE.com', user)).toEqual({ erased: 3, keptOpen: 1 })

    for (const { orderId } of [closedA, closedB, legacyClosed]) {
      expect(await getOrder(ctx, org, orderId)).toMatchObject({ buyer: null, buyerDataErasedAt: expect.any(Date) })
      expect(await rawRow(ctx, orderId)).not.toMatch(/anna|nowak|Prywatna/i)
    }
    for (const { order, orderId } of [open, someoneElse, noEmail]) expect((await getOrder(ctx, org, orderId))?.buyer).toEqual(order.buyer)
    expect((await getOrder(ctx, other.org, otherTenant.orderId))?.buyer).toEqual(otherTenant.order.buyer)

    const events = await ctx.db.eventLog.findMany({
      where: { organizationId: org, type: { in: ['order.buyer_data_erased', 'privacy.erasure_requested'] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    expect(events.filter((event) => event.type === 'order.buyer_data_erased').map((event) => event.subjectId).sort()).toEqual(
      [closedA.orderId, closedB.orderId, legacyClosed.orderId].sort(),
    )
    expect(events.find((event) => event.type === 'privacy.erasure_requested')?.payload).toEqual({ erased: 3, keptOpen: 1, actor: user })
    expect(JSON.stringify(events)).not.toMatch(/anna|nowak/i)

    // Asked again: nothing left to erase, the open Order is still reported.
    expect(await previewBuyerErasure(ctx, org, 'anna.nowak@example.com')).toEqual({ closed: 0, open: 1 })
    expect(await eraseBuyerData(ctx, org, 'anna.nowak@example.com', user)).toEqual({ erased: 0, keptOpen: 1 })
  })
})
