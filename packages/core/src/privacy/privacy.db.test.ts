import type { Order } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import type { Actor } from '../actor'
import type { Context } from '../context'
import { DomainError } from '../errors'
import { changeOrderStatus } from '../orders/change-status'
import { importOrder } from '../orders/import'
import { getOrder, listOrders } from '../orders/queries'
import { createTestOrganization, type TestContext } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { addMember, buildOrder, createTestConnection, fact } from '../testing/fixtures'
import { eraseBuyerData, previewBuyerErasure } from './erasure'
import { canManagePrivacy } from './permissions'
import { getPrivacySettings, previewBuyerDataRetention, setBuyerDataRetention } from './settings'
import { applyBuyerDataRetention, sealLegacyBuyerData, sweepBuyerData, SWEEP_BATCH_SIZE } from './sweep'

const DAY = 86_400_000

/** The raw row as Postgres stores it, every column as text. */
async function rawRow(ctx: TestContext, orderId: string): Promise<string> {
  const [row] = await ctx.db.$queryRaw<Array<{ row: unknown }>>`SELECT row_to_json(o) AS "row" FROM "order" o WHERE "id" = ${orderId}`
  return JSON.stringify(row?.row)
}

/** Rewrites an Order into the shape written before ADR 0011; `shippingAddress` may be overridden with something invalid. */
async function makeLegacy(ctx: TestContext, orderId: string, order: Order, shippingAddress: unknown = order.shippingAddress): Promise<void> {
  await ctx.db.$executeRaw`
    UPDATE "order" SET "buyerData" = NULL, "buyerEmailIndex" = NULL, "shippingCountryCode" = NULL,
      "buyerName" = ${order.buyer.name}, "buyerEmail" = ${order.buyer.email}, "buyerPhone" = ${order.buyer.phone},
      "buyerLogin" = ${order.buyer.login}, "shippingAddress" = ${JSON.stringify(shippingAddress)}::jsonb,
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

function withLogCapture(ctx: TestContext): { ctx: Context; logged: Array<Record<string, unknown>> } {
  const logged: Array<Record<string, unknown>> = []
  const log = { info: (message: string, fields?: Record<string, unknown>) => logged.push({ message, ...fields }), error: (message: string, fields?: Record<string, unknown>) => logged.push({ message, ...fields }) }
  return { ctx: { ...ctx, log }, logged }
}

describe.skipIf(!databaseUrl)('Buyer data privacy', () => {
  const context = useTestContext()

  async function setup() {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const connectionId = await createTestConnection(ctx, org)
    const admin = await addMember(ctx, org, 'owner')
    const importOne = async (overrides: Partial<Order> = {}) => {
      const order = buildOrder(overrides)
      return { order, orderId: (await importOrder(ctx, org, connectionId, order)).orderId }
    }
    return { ctx, org, connectionId, admin, importOne }
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
      buyerDataState: 'present',
      buyerDataErasedAt: null,
    })
    expect((await listOrders(ctx, org, { skip: 0, take: 10 })).items[0]).toMatchObject({ buyerName: 'Anna Nowak', buyerDataState: 'present' })
  })

  it('one value that does not open marks only its own Order unreadable, and logs the Order id only', async () => {
    const { ctx: base, org, importOne } = await setup()
    const { ctx, logged } = withLogCapture(base)
    const damaged = await importOne(buyer('anna.nowak@example.com'))
    const moved = await importOne()
    const fine = await importOne()
    const { buyerData } = await base.db.order.findFirstOrThrow({ where: { id: damaged.orderId } })
    const [version, iv, tag, ciphertext] = buyerData!.split(':') as [string, string, string, string]
    const bytes = Buffer.from(ciphertext, 'base64')
    bytes[0] = (bytes[0] ?? 0) ^ 1
    await base.db.order.update({ where: { id: damaged.orderId }, data: { buyerData: [version, iv, tag, bytes.toString('base64')].join(':') } })
    // A sealed value copied from another Order does not open either.
    const { buyerData: other } = await base.db.order.findFirstOrThrow({ where: { id: fine.orderId } })
    await base.db.order.update({ where: { id: moved.orderId }, data: { buyerData: other } })

    const list = await listOrders(ctx, org, { skip: 0, take: 10 })
    const byId = new Map(list.items.map((row) => [row.id, row]))
    expect(list.items).toHaveLength(3)
    expect(byId.get(damaged.orderId)).toMatchObject({ buyerName: null, buyerDataState: 'unreadable' })
    expect(byId.get(moved.orderId)).toMatchObject({ buyerName: null, buyerDataState: 'unreadable' })
    expect(byId.get(fine.orderId)).toMatchObject({ buyerName: 'John Test', buyerDataState: 'present' })
    expect(await getOrder(ctx, org, damaged.orderId)).toMatchObject({ buyer: null, shippingAddress: null, buyerDataState: 'unreadable', shippingCountryCode: 'PL' })

    expect(logged).toContainEqual({ message: 'buyer data unreadable', organizationId: org, orderId: damaged.orderId })
    expect(JSON.stringify(logged)).not.toMatch(/anna|nowak|v1:/i)
  })

  it('records when an Order closed: by a person or by a Channel fact, not for open statuses', async () => {
    const { ctx, org, admin, importOne } = await setup()
    const byPerson = await importOne()
    const processing = await importOne()
    const byFact = await importOne({ facts: [fact('f1', 'shipped')] })
    await changeOrderStatus(ctx, org, byPerson.orderId, 'cancelled', admin)
    await changeOrderStatus(ctx, org, processing.orderId, 'processing', admin)

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

    expect(await sealLegacyBuyerData(ctx, org)).toEqual({ sealed: 1, failed: 0, scanned: 1 })
    expect(await sealLegacyBuyerData(ctx, org)).toEqual({ sealed: 0, failed: 0, scanned: 0 })

    const raw = await rawRow(ctx, legacy.orderId)
    expect(raw).not.toContain('Lena')
    expect(raw).not.toContain('legacy@example.com')
    expect(raw).toContain('"shippingCountryCode":"PL"')
    expect(await getOrder(ctx, org, legacy.orderId)).toMatchObject({ buyer: legacy.order.buyer, shippingAddress: legacy.order.shippingAddress })
    // An Order sealed on import is left alone.
    expect((await ctx.db.order.findFirstOrThrow({ where: { id: other.orderId } })).buyerData).toBe(otherBefore.buyerData)
  })

  it('a legacy row that fails the schema is marked and skipped, never blocks sealing or retention, and can still be erased', async () => {
    const { ctx: base, org, admin, importOne } = await setup()
    const { ctx, logged } = withLogCapture(base)
    const now = new Date()
    const bad = await importOne(buyer('broken@example.com', 'Bruno Broken'))
    const good = await importOne(buyer('good@example.com', 'Greta Good'))
    const oldClosed = await importOne()
    await makeLegacy(base, bad.orderId, bad.order, { name: 'Bruno Broken', street: 'ul. Zepsuta 1', city: 'Łódź' })
    await makeLegacy(base, good.orderId, good.order)
    await closeDaysAgo(base, oldClosed.orderId, 40, now)
    await setBuyerDataRetention(base, org, 30, admin)

    expect(await sweepBuyerData(ctx, org, now)).toEqual({ sealed: 1, sealFailed: 1, erased: 1, more: false })
    expect((await base.db.order.findFirstOrThrow({ where: { id: bad.orderId } })).buyerDataSealFailedAt).toEqual(now)
    expect(await rawRow(base, good.orderId)).not.toContain('Greta')
    expect((await getOrder(base, org, oldClosed.orderId))?.buyerDataState).toBe('erased')
    // Not rescanned on the next run.
    expect(await sweepBuyerData(ctx, org, now)).toEqual({ sealed: 0, sealFailed: 0, erased: 0, more: false })

    const failure = logged.find((entry) => entry.message === 'legacy buyer data not sealed')
    expect(failure).toEqual({
      message: 'legacy buyer data not sealed',
      organizationId: org,
      orderId: bad.orderId,
      error: 'ZodError: shippingAddress.company invalid_type; shippingAddress.postalCode invalid_type; shippingAddress.countryCode invalid_type; shippingAddress.phone invalid_type; shippingAddress.taxId invalid_type',
    })
    expect(JSON.stringify(logged)).not.toMatch(/bruno|zepsuta|broken@/i)
    expect((await getOrder(base, org, bad.orderId))?.buyerDataState).toBe('unreadable')

    // An erasure request still finds it on its plaintext email and clears it.
    await closeDaysAgo(base, bad.orderId, 1, now)
    expect(await eraseBuyerData(base, org, 'BROKEN@example.com', admin)).toEqual({ erased: 1, keptOpen: 0 })
    expect(await rawRow(base, bad.orderId)).not.toMatch(/bruno|zepsuta|broken/i)

    // So does retention, once it is old enough.
    const badOld = await importOne(buyer('old.broken@example.com', 'Olga Broken'))
    await makeLegacy(base, badOld.orderId, badOld.order, { name: 'Olga Broken' })
    await sweepBuyerData(ctx, org, now)
    await closeDaysAgo(base, badOld.orderId, 40, now)
    expect(await sweepBuyerData(ctx, org, now)).toMatchObject({ erased: 1 })
    expect(await rawRow(base, badOld.orderId)).not.toMatch(/olga/i)
  })

  it('legacy rows with a name but no address are marked, so a sweep over several batches ends', async () => {
    const { ctx: base, org, connectionId } = await setup()
    const { ctx, logged } = withLogCapture(base)
    const count = SWEEP_BATCH_SIZE * 2 + 50
    await base.db.$executeRaw`
      INSERT INTO "order" ("id", "organizationId", "connectionId", "externalId", "placedAt", "payment", "currency", "totalAmount", "buyerName", "updatedAt")
      SELECT gen_random_uuid()::text, ${org}, ${connectionId}, 'partial-' || n, now(), 'prepaid', 'PLN', 10, 'Paula Partial', now()
      FROM generate_series(1, ${count}::int) AS n`

    expect(await sweepBuyerData(ctx, org, new Date())).toEqual({ sealed: 0, sealFailed: count, erased: 0, more: false })
    expect(await sweepBuyerData(ctx, org, new Date())).toEqual({ sealed: 0, sealFailed: 0, erased: 0, more: false })
    expect(await base.db.order.count({ where: { organizationId: org, buyerDataSealFailedAt: { not: null } } })).toBe(count)
    expect(JSON.stringify(logged)).not.toMatch(/paula/i)
  })

  it('retention erases only Closed Orders past the period, in its own organization, and only once', async () => {
    const { ctx, org, admin, importOne } = await setup()
    const other = await setup()
    const now = new Date()
    const old = await importOne({ facts: [{ ...fact('f1', 'shipped'), note: 'Buyer Anna asked for a gift wrap' }] })
    const recent = await importOne()
    const open = await importOne({ placedAt: '2020-01-01T00:00:00Z' })
    const openWithClosedAt = await importOne()
    const otherOld = await other.importOne()
    await closeDaysAgo(ctx, old.orderId, 40, now)
    await closeDaysAgo(ctx, recent.orderId, 10, now)
    await closeDaysAgo(ctx, otherOld.orderId, 400, now)
    // Defensive: an open Order is never erased, whatever its closedAt says.
    await ctx.db.order.update({ where: { id: openWithClosedAt.orderId }, data: { closedAt: new Date(now.getTime() - 400 * DAY) } })

    expect(await applyBuyerDataRetention(ctx, org, now)).toBe(0)
    expect(await previewBuyerDataRetention(ctx, org, 30, admin, now)).toEqual({ erasedAtNextCheck: 1 })
    expect(await previewBuyerDataRetention(ctx, org, 5, admin, now)).toEqual({ erasedAtNextCheck: 2 })
    await setBuyerDataRetention(ctx, org, 30, admin)
    expect(await getPrivacySettings(ctx, org)).toEqual({ buyerDataRetentionDays: 30 })

    expect(await sweepBuyerData(ctx, org, now)).toEqual({ sealed: 0, sealFailed: 0, erased: 1, more: false })
    expect(await sweepBuyerData(ctx, org, now)).toEqual({ sealed: 0, sealFailed: 0, erased: 0, more: false })
    expect(await previewBuyerDataRetention(ctx, org, 30, admin, now)).toEqual({ erasedAtNextCheck: 0 })

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
    expect(await getOrder(ctx, org, old.orderId)).toMatchObject({ buyer: null, buyerDataState: 'erased', shippingCountryCode: 'PL' })

    for (const kept of [recent, open, openWithClosedAt]) expect((await getOrder(ctx, org, kept.orderId))?.buyer).toEqual(kept.order.buyer)
    expect((await getOrder(ctx, other.org, otherOld.orderId))?.buyer).toEqual(otherOld.order.buyer)

    const events = await ctx.db.eventLog.findMany({ where: { organizationId: org, type: 'order.buyer_data_erased' } })
    expect(events.map((event) => [event.subjectId, event.payload])).toEqual([
      [old.orderId, { cause: 'retention', retentionDays: 30, actor: { type: 'system' } }],
    ])
    const settingEvents = await ctx.db.eventLog.findMany({ where: { organizationId: org, type: 'privacy.retention_changed' } })
    expect(settingEvents.map((event) => event.payload)).toEqual([{ from: null, to: 30, actor: admin }])
  })

  it('the sweep gives Closed Orders without closedAt their last change time, and retention counts from it', async () => {
    const { ctx, org, admin, importOne } = await setup()
    const now = new Date()
    const closedByOldCode = await importOne()
    const longAgo = new Date(now.getTime() - 100 * DAY)
    await ctx.db.$executeRaw`UPDATE "order" SET "status" = 'cancelled', "closedAt" = NULL, "updatedAt" = ${longAgo} WHERE "id" = ${closedByOldCode.orderId}`
    expect(await previewBuyerDataRetention(ctx, org, 30, admin, now)).toEqual({ erasedAtNextCheck: 1 })
    await setBuyerDataRetention(ctx, org, 30, admin)

    expect(await sweepBuyerData(ctx, org, now)).toMatchObject({ erased: 1 })
    const row = await ctx.db.order.findFirstOrThrow({ where: { id: closedByOldCode.orderId } })
    expect(row.closedAt).toEqual(longAgo)
    expect(row.buyerDataErasedAt).toEqual(now)
  })

  it('refuses a retention outside 1-3650 days, and records nothing when it does not change', async () => {
    const { ctx, org, admin } = await setup()
    for (const days of [0, -1, 3651, 1.5]) await expect(setBuyerDataRetention(ctx, org, days, admin)).rejects.toThrow(RangeError)
    await setBuyerDataRetention(ctx, org, null, admin)
    expect(await ctx.db.eventLog.count({ where: { organizationId: org, type: 'privacy.retention_changed' } })).toBe(0)
  })

  it('only owners and admins may change retention or handle an erasure request', async () => {
    const { ctx, org, admin } = await setup()
    const other = await setup()
    const member = await addMember(ctx, org, 'member')
    const adminByRole = await addMember(ctx, org, 'admin')
    const several = await addMember(ctx, org, 'member, admin')
    const outsider = other.admin

    for (const actor of [member, outsider] as Actor[]) {
      await expect(setBuyerDataRetention(ctx, org, 30, actor)).rejects.toThrow(DomainError)
      await expect(previewBuyerDataRetention(ctx, org, 30, actor)).rejects.toMatchObject({ code: 'forbidden' })
      await expect(previewBuyerErasure(ctx, org, 'anna@example.com', actor)).rejects.toMatchObject({ code: 'forbidden' })
      await expect(eraseBuyerData(ctx, org, 'anna@example.com', actor)).rejects.toMatchObject({ code: 'forbidden' })
    }
    expect(await ctx.db.eventLog.count({ where: { organizationId: org, type: { startsWith: 'privacy.' } } })).toBe(0)

    for (const actor of [admin, adminByRole, several]) {
      expect(await canManagePrivacy(ctx, org, (actor as { userId: string }).userId)).toBe(true)
      await expect(previewBuyerErasure(ctx, org, 'anna@example.com', actor)).resolves.toEqual({ closed: 0, open: 0 })
    }
    await setBuyerDataRetention(ctx, org, 30, adminByRole)
    expect(await getPrivacySettings(ctx, org)).toEqual({ buyerDataRetentionDays: 30 })
    expect(await canManagePrivacy(ctx, org, (member as { userId: string }).userId)).toBe(false)
  })

  it('an erasure request erases exactly one person’s Closed Orders in one organization and keeps the open ones', async () => {
    const { ctx, org, admin, importOne } = await setup()
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

    expect(await previewBuyerErasure(ctx, org, ' anna.nowak@EXAMPLE.com', admin)).toEqual({ closed: 3, open: 1 })
    expect(await eraseBuyerData(ctx, org, ' anna.nowak@EXAMPLE.com', admin)).toEqual({ erased: 3, keptOpen: 1 })

    for (const { orderId } of [closedA, closedB, legacyClosed]) {
      expect(await getOrder(ctx, org, orderId)).toMatchObject({ buyer: null, buyerDataState: 'erased', buyerDataErasedAt: expect.any(Date) })
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
    expect(events.find((event) => event.type === 'privacy.erasure_requested')?.payload).toEqual({ erased: 3, keptOpen: 1, actor: admin })
    expect(JSON.stringify(events)).not.toMatch(/anna|nowak/i)

    // Asked again: nothing left to erase, the open Order is still reported.
    expect(await previewBuyerErasure(ctx, org, 'anna.nowak@example.com', admin)).toEqual({ closed: 0, open: 1 })
    expect(await eraseBuyerData(ctx, org, 'anna.nowak@example.com', admin)).toEqual({ erased: 0, keptOpen: 1 })
  })

  it('an erasure request treats _ and % literally, on sealed and on legacy rows', async () => {
    const { ctx, org, admin, importOne } = await setup()
    const john = await importOne(buyer('john@example.com', 'John Wildcard'))
    const legacyJohn = await importOne(buyer('john@example.org', 'John Legacy'))
    const underscore = await importOne(buyer('j_hn@example.com', 'Jane Underscore'))
    await makeLegacy(ctx, legacyJohn.orderId, legacyJohn.order)
    for (const { orderId } of [john, legacyJohn, underscore]) await closeDaysAgo(ctx, orderId, 1)

    for (const email of ['j_hn@example.org', '%@example.org', 'john@example.%', '_ohn@example.org', '%', 'j%']) {
      expect(await previewBuyerErasure(ctx, org, email, admin), email).toEqual({ closed: 0, open: 0 })
    }
    expect(await previewBuyerErasure(ctx, org, '%@example.com', admin)).toEqual({ closed: 0, open: 0 })
    expect(await eraseBuyerData(ctx, org, 'j_hn@example.com', admin)).toEqual({ erased: 1, keptOpen: 0 })
    expect((await getOrder(ctx, org, underscore.orderId))?.buyerDataState).toBe('erased')
    expect((await getOrder(ctx, org, john.orderId))?.buyer?.name).toBe('John Wildcard')
    expect((await getOrder(ctx, org, legacyJohn.orderId))?.buyer?.name).toBe('John Legacy')
  })

  it('trims stored emails the way JS does (tab, NBSP, BOM, wide spaces) on legacy rows as on sealed ones', async () => {
    const { ctx, org, admin, importOne } = await setup()
    const stored = ['x@example.com\t', '\u00a0X@example.com\u2003', '\ufeffx@example.com\u3000', '\n x@EXAMPLE.com \r']
    const legacy = []
    for (const email of stored) legacy.push(await importOne(buyer(email, 'Xavier Space')))
    const sealed = await importOne(buyer('x@example.com\t', 'Xavier Sealed'))
    for (const row of legacy) await makeLegacy(ctx, row.orderId, row.order)
    for (const { orderId } of [...legacy, sealed]) await closeDaysAgo(ctx, orderId, 1)

    expect(await previewBuyerErasure(ctx, org, 'x@example.com', admin)).toEqual({ closed: 5, open: 0 })
    expect(await previewBuyerErasure(ctx, org, 'x@example.co', admin)).toEqual({ closed: 0, open: 0 })
  })

  it('matches an email written with decomposed Unicode on sealed and legacy rows', async () => {
    const { ctx, org, admin, importOne } = await setup()
    const sealed = await importOne(buyer('josé@example.com', 'José Sealed'))
    const legacy = await importOne(buyer('José@example.com', 'José Legacy'))
    await makeLegacy(ctx, legacy.orderId, legacy.order)
    for (const { orderId } of [sealed, legacy]) await closeDaysAgo(ctx, orderId, 1)
    expect(await previewBuyerErasure(ctx, org, 'JOSÉ@EXAMPLE.COM', admin)).toEqual({ closed: 2, open: 0 })
  })

  it('a fact pulled after the Buyer data was erased does not bring a note back', async () => {
    const { ctx, org, connectionId, admin, importOne } = await setup()
    const { order, orderId } = await importOne(buyer('anna.nowak@example.com'))
    await changeOrderStatus(ctx, org, orderId, 'cancelled', admin)
    await eraseBuyerData(ctx, org, 'anna.nowak@example.com', admin)

    const again = { ...order, facts: [{ ...fact('late', 'cancelled'), note: 'Anna Nowak wrote: please call +48 600 100 200' }] }
    expect(await importOrder(ctx, org, connectionId, again)).toMatchObject({ created: false, factsApplied: 1 })

    const row = await ctx.db.order.findFirstOrThrow({ where: { id: orderId }, include: { facts: true } })
    expect(row.facts.map((stored) => [stored.externalId, stored.note])).toEqual([['late', null]])
    expect(row.buyerData).toBeNull()
    expect(await rawRow(ctx, orderId)).not.toMatch(/anna|nowak/i)
    expect((await getOrder(ctx, org, orderId))?.buyerDataState).toBe('erased')
  })
})
