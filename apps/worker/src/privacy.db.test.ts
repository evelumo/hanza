import { createFakeChannel, type FakeChannel } from '@hanza/connector-fake'
import {
  addConnection,
  changeOrderStatus,
  eraseBuyerData,
  getOrder,
  jobs,
  listOrders,
  previewBuyerErasure,
  privacyTickRef,
  setBuyerDataRetention,
  type Actor,
} from '@hanza/core'
import { createTestContext, createTestOrganization, type TestContext } from '@hanza/core/testing'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

const databaseUrl = inject('hanzaTestDatabaseUrl')
const user: Actor = { type: 'user', userId: 'user-1' }
const DAY = 86_400_000

// Everything personal the fake Channel sends about its Buyers.
const JOHN = ['John Test', 'john.test@example.com', 'john_test', '1 Example Street']
const MARIA = ['Maria Example', 'maria@example.com', '2 Private Road']

describe.skipIf(!databaseUrl)('Buyer data privacy end to end (real Postgres, in-memory queue, fake Channel)', () => {
  let ctx: TestContext
  let fake: FakeChannel
  let orgA: string
  let orgB: string

  beforeAll(async () => {
    fake = createFakeChannel()
    fake.addOrder({
      externalId: 'fake-order-maria',
      placedAt: '2026-10-01T13:00:00Z',
      payment: 'prepaid',
      total: { amount: '25.00', currency: 'PLN' },
      buyer: { name: 'Maria Example', email: 'maria@example.com', phone: '+48 500 000 000', login: null },
      shippingAddress: {
        name: 'Maria Example',
        company: null,
        street: '2 Private Road',
        postalCode: '30-001',
        city: 'Kraków',
        countryCode: 'PL',
        phone: null,
        taxId: null,
      },
      billingAddress: null,
      lines: [{ externalId: 'l1', offerExternalId: 'fake-offer-3', sku: 'FAKE-SKU-3', name: 'Poster A3', quantity: 1, unitPrice: { amount: '25.00', currency: 'PLN' } }],
      facts: [],
    })
    ctx = createTestContext({ databaseUrl: databaseUrl!, connectors: [fake.connector] })
    orgA = await createTestOrganization(ctx.db)
    orgB = await createTestOrganization(ctx.db)
  })

  afterAll(async () => {
    await ctx?.db.$disconnect()
  })

  async function drain() {
    const result = await ctx.queue.drain(ctx, jobs)
    expect(result.failed).toEqual([])
    return result
  }

  async function tick() {
    await ctx.queue.enqueue(privacyTickRef, {})
    await drain()
  }

  function orderId(org: string, externalId: string) {
    return ctx.db.order.findFirstOrThrow({ where: { organizationId: org, externalId }, select: { id: true } }).then((row) => row.id)
  }

  /** The raw row as Postgres stores it, every column as text. */
  async function rawRow(org: string, externalId: string): Promise<string> {
    const id = await orderId(org, externalId)
    const [row] = await ctx.db.$queryRaw<Array<{ row: unknown }>>`SELECT row_to_json(o) AS "row" FROM "order" o WHERE "id" = ${id}`
    return JSON.stringify(row?.row)
  }

  async function buyerOf(org: string, externalId: string) {
    return (await getOrder(ctx, org, await orderId(org, externalId)))?.buyer ?? null
  }

  async function erasedEvents(org: string) {
    return ctx.db.eventLog.findMany({ where: { organizationId: org, type: 'order.buyer_data_erased' }, orderBy: { id: 'asc' } })
  }

  it('1. an Order imported through the engine has no plaintext Buyer data in its row; the panel reads it decrypted', async () => {
    for (const org of [orgA, orgB]) {
      await addConnection(ctx, org, { connectorId: 'fake', name: 'Fake', config: { failMode: 'none' }, credentials: { apiKey: 'test' } }, user)
    }
    await drain()
    for (const org of [orgA, orgB]) expect(await ctx.db.order.count({ where: { organizationId: org } })).toBe(5)

    for (const externalId of ['fake-order-1', 'fake-order-2', 'fake-order-3', 'fake-order-4']) {
      const raw = await rawRow(orgA, externalId)
      for (const personal of JOHN) expect(raw).not.toContain(personal)
      expect(raw).toMatch(/"buyerData":"v1:/)
    }
    for (const personal of MARIA) expect(await rawRow(orgA, 'fake-order-maria')).not.toContain(personal)

    expect(await getOrder(ctx, orgA, await orderId(orgA, 'fake-order-1'))).toMatchObject({
      buyer: { name: 'John Test', email: 'john.test@example.com', phone: null, login: 'john_test' },
      shippingAddress: { street: '1 Example Street', city: 'Warsaw', countryCode: 'PL' },
    })
    const list = await listOrders(ctx, orgA, { skip: 0, take: 10 })
    expect(list.items.map((row) => row.buyerName).sort()).toEqual(['John Test', 'John Test', 'John Test', 'John Test', 'Maria Example'])
    // The Channel's cancellation closed fake-order-2.
    expect((await ctx.db.order.findFirstOrThrow({ where: { id: await orderId(orgA, 'fake-order-2') } })).closedAt).toBeInstanceOf(Date)
  })

  it('2. privacy.tick seals legacy plaintext rows of every organization, and re-running changes nothing', async () => {
    for (const org of [orgA, orgB]) {
      await ctx.db.$executeRaw`
        UPDATE "order" SET "buyerData" = NULL, "buyerEmailIndex" = NULL, "shippingCountryCode" = NULL,
          "buyerName" = 'John Test', "buyerEmail" = 'john.test@example.com', "buyerPhone" = NULL, "buyerLogin" = 'john_test',
          "shippingAddress" = ${JSON.stringify({ name: 'John Test', company: null, street: '1 Example Street', postalCode: '00-001', city: 'Warsaw', countryCode: 'PL', phone: null, taxId: null })}::jsonb,
          "billingAddress" = NULL
        WHERE "organizationId" = ${org} AND "externalId" IN ('fake-order-1', 'fake-order-3')`
    }
    expect(await rawRow(orgA, 'fake-order-1')).toContain('john.test@example.com')
    expect(await buyerOf(orgA, 'fake-order-1')).toMatchObject({ name: 'John Test' })

    const before = ctx.queue.enqueued.length
    await tick()
    const sweeps = ctx.queue.enqueued.slice(before).filter((job) => job.name === 'privacy.sweep')
    expect(sweeps.map((job) => (job.payload as { organizationId: string }).organizationId)).toEqual(expect.arrayContaining([orgA, orgB]))

    for (const org of [orgA, orgB]) {
      for (const externalId of ['fake-order-1', 'fake-order-3']) {
        const raw = await rawRow(org, externalId)
        for (const personal of JOHN) expect(raw).not.toContain(personal)
        expect(raw).toContain('"shippingCountryCode":"PL"')
        expect(await buyerOf(org, externalId)).toEqual({ name: 'John Test', email: 'john.test@example.com', phone: null, login: 'john_test' })
      }
    }
    const sealed = await ctx.db.order.findMany({ where: { organizationId: orgA }, select: { id: true, buyerData: true }, orderBy: { id: 'asc' } })
    await tick()
    expect(await ctx.db.order.findMany({ where: { organizationId: orgA }, select: { id: true, buyerData: true }, orderBy: { id: 'asc' } })).toEqual(sealed)
  })

  it('3. retention erases only eligible Orders of the organization that set it, once', async () => {
    await setBuyerDataRetention(ctx, orgA, 30, user)
    // fake-order-2 was cancelled 40 days ago in both organizations; only orgA keeps Buyer data for 30 days.
    for (const org of [orgA, orgB]) {
      await ctx.db.order.update({ where: { id: await orderId(org, 'fake-order-2') }, data: { closedAt: new Date(Date.now() - 40 * DAY) } })
    }
    await tick()

    expect(await buyerOf(orgA, 'fake-order-2')).toBeNull()
    const erased = await ctx.db.order.findFirstOrThrow({ where: { id: await orderId(orgA, 'fake-order-2') }, include: { lines: true, facts: true } })
    expect(erased).toMatchObject({ buyerData: null, buyerEmailIndex: null, shippingCountryCode: 'PL', status: 'cancelled' })
    expect(erased.buyerDataErasedAt).toBeInstanceOf(Date)
    expect(erased.totalAmount.toFixed()).toBe('84')
    expect(erased.lines).toHaveLength(2)
    expect(erased.facts.map((row) => row.note)).toEqual([null])

    for (const externalId of ['fake-order-1', 'fake-order-3', 'fake-order-4']) expect(await buyerOf(orgA, externalId)).not.toBeNull()
    expect(await buyerOf(orgB, 'fake-order-2')).toMatchObject({ name: 'John Test' })

    const events = await erasedEvents(orgA)
    expect(events.map((event) => event.payload)).toEqual([{ cause: 'retention', retentionDays: 30, actor: { type: 'system' } }])
    await tick()
    expect(await erasedEvents(orgA)).toHaveLength(1)
    expect(await erasedEvents(orgB)).toHaveLength(0)
  })

  it('4. an erasure request erases exactly the matching person’s closed Orders in its organization', async () => {
    for (const externalId of ['fake-order-3', 'fake-order-4', 'fake-order-maria']) {
      await changeOrderStatus(ctx, orgA, await orderId(orgA, externalId), 'cancelled', user)
    }
    await changeOrderStatus(ctx, orgB, await orderId(orgB, 'fake-order-3'), 'cancelled', user)
    await drain()

    // fake-order-2 is erased already, fake-order-1 is still open.
    expect(await previewBuyerErasure(ctx, orgA, 'John.Test@example.com')).toEqual({ closed: 2, open: 1 })
    expect(await eraseBuyerData(ctx, orgA, 'John.Test@example.com', user)).toEqual({ erased: 2, keptOpen: 1 })

    for (const externalId of ['fake-order-3', 'fake-order-4']) {
      expect(await buyerOf(orgA, externalId)).toBeNull()
      for (const personal of JOHN) expect(await rawRow(orgA, externalId)).not.toContain(personal)
    }
    expect(await buyerOf(orgA, 'fake-order-1')).toMatchObject({ name: 'John Test' })
    expect(await buyerOf(orgA, 'fake-order-maria')).toMatchObject({ name: 'Maria Example', email: 'maria@example.com' })
    for (const externalId of ['fake-order-1', 'fake-order-2', 'fake-order-3', 'fake-order-4']) {
      expect(await buyerOf(orgB, externalId)).toMatchObject({ name: 'John Test' })
    }

    const events = await ctx.db.eventLog.findMany({ where: { organizationId: orgA, type: { in: ['order.buyer_data_erased', 'privacy.erasure_requested'] } } })
    expect(events.filter((event) => (event.payload as { cause?: string }).cause === 'erasure_request')).toHaveLength(2)
    expect(events.find((event) => event.type === 'privacy.erasure_requested')?.payload).toEqual({ erased: 2, keptOpen: 1, actor: user })
    expect(JSON.stringify(events)).not.toMatch(/john|example\.com/i)
    expect(await erasedEvents(orgB)).toHaveLength(0)
  })
})
