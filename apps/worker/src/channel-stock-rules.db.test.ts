import { createFakeChannel, type FakeChannel } from '@hanza/connector-fake'
import {
  addConnection,
  changeOrderStatus,
  coalesceKeys,
  createProduct,
  getAvailability,
  jobs,
  ordersPullRef,
  setStock,
  updateChannelStockRules,
  type Actor,
} from '@hanza/core'
import { createTestContext, createTestOrganization, type TestContext } from '@hanza/core/testing'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

const databaseUrl = inject('hanzaTestDatabaseUrl')
const user: Actor = { type: 'user', userId: 'user-1' }

type Order = Parameters<FakeChannel['addOrder']>[0]

// Two independent fake Channels (own Offers, Orders and recorded pushes), each with its own
// Connection, linked by SKU to the same three Products. Both Channels start with the fake's seed:
// fake-order-1 reserves 2 × FAKE-SKU-1; fake-order-2 (SKU-2, SKU-3) arrives cancelled.
describe.skipIf(!databaseUrl)('Channel stock rules end to end (real Postgres, in-memory queue, two fake Channels)', () => {
  let ctx: TestContext
  let marketplace: FakeChannel
  let shop: FakeChannel
  let org: string
  const connections = { marketplace: '', shop: '' }
  const products: Record<string, string> = {}
  const offerFor = { 'FAKE-SKU-1': 'fake-offer-1', 'FAKE-SKU-2': 'fake-offer-2', 'FAKE-SKU-3': 'fake-offer-3' } as const
  type Sku = keyof typeof offerFor

  beforeAll(async () => {
    marketplace = createFakeChannel()
    shop = createFakeChannel({ id: 'fake-shop' })
    ctx = createTestContext({ databaseUrl: databaseUrl!, connectors: [marketplace.connector, shop.connector] })
    org = await createTestOrganization(ctx.db)
  })

  afterAll(async () => {
    await ctx?.db.$disconnect()
  })

  async function drain() {
    const result = await ctx.queue.drain(ctx, jobs)
    expect(result.failed).toEqual([])
    expect(ctx.queue.waiting).toEqual([])
    return result
  }

  /** The last number this Channel was told for each SKU's Offer. */
  function told(channel: FakeChannel): Record<Sku, number | undefined> {
    const last = (offerExternalId: string) => {
      for (const levels of [...channel.stockPushes].reverse()) {
        const level = levels.find((candidate) => candidate.offerExternalId === offerExternalId)
        if (level) return level.available
      }
      return undefined
    }
    return { 'FAKE-SKU-1': last(offerFor['FAKE-SKU-1']), 'FAKE-SKU-2': last(offerFor['FAKE-SKU-2']), 'FAKE-SKU-3': last(offerFor['FAKE-SKU-3']) }
  }

  async function available(): Promise<Record<Sku, number>> {
    const availability = await getAvailability(ctx.db, org, Object.values(products))
    const of = (sku: Sku) => availability.get(products[sku]!)!.available
    return { 'FAKE-SKU-1': of('FAKE-SKU-1'), 'FAKE-SKU-2': of('FAKE-SKU-2'), 'FAKE-SKU-3': of('FAKE-SKU-3') }
  }

  /** Every linked Offer is pushed, and no Channel was told more than Available or less than zero. */
  async function expectInvariants() {
    const truth = await available()
    for (const channel of [marketplace, shop]) {
      for (const [sku, value] of Object.entries(told(channel)) as Array<[Sku, number | undefined]>) {
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(Math.max(0, truth[sku]))
      }
    }
    const offers = await ctx.db.offer.findMany({ where: { organizationId: org, productId: { not: null } } })
    expect(offers.every((offer) => offer.stockPushedSeq === offer.stockPushSeq)).toBe(true)
  }

  async function pullOrders(connectionId: string) {
    await ctx.queue.enqueue(
      ordersPullRef,
      { organizationId: org, connectionId, trigger: 'schedule' },
      { coalesceKey: coalesceKeys.ordersPull(connectionId) },
    )
    await drain()
  }

  function newOrder(externalId: string, sku: Sku, quantity: number): Order {
    return {
      externalId,
      placedAt: '2026-10-05T09:00:00Z',
      payment: 'prepaid',
      total: { amount: '10.00', currency: 'PLN' },
      buyer: { name: 'Jane Test', email: 'jane.test@example.com', phone: null, login: 'jane_test' },
      shippingAddress: {
        name: 'Jane Test',
        company: null,
        street: '2 Example Street',
        postalCode: '00-002',
        city: 'Warsaw',
        countryCode: 'PL',
        phone: null,
        taxId: null,
      },
      billingAddress: null,
      lines: [{ externalId: 'l1', offerExternalId: offerFor[sku], sku, name: sku, quantity, unitPrice: { amount: '10.00', currency: 'PLN' } }],
      facts: [],
    }
  }

  it('1. without rules both Channels are told Available', async () => {
    for (const [sku, stock] of [['FAKE-SKU-1', 20], ['FAKE-SKU-2', 4], ['FAKE-SKU-3', 1]] as const) {
      products[sku] = (await createProduct(ctx, org, { sku, name: sku, stock }, user)).productId
    }
    const add = (connectorId: string, name: string) =>
      addConnection(ctx, org, { connectorId, name, config: { failMode: 'none' }, credentials: { apiKey: 'test' } }, user)
    connections.marketplace = (await add('fake', 'Marketplace')).connectionId
    connections.shop = (await add('fake-shop', 'Shop')).connectionId
    await drain()

    // Each Channel's fake-order-1 reserves 2 × SKU-1: 20 − 4 = 16.
    expect(await available()).toEqual({ 'FAKE-SKU-1': 16, 'FAKE-SKU-2': 4, 'FAKE-SKU-3': 1 })
    expect(told(marketplace)).toEqual({ 'FAKE-SKU-1': 16, 'FAKE-SKU-2': 4, 'FAKE-SKU-3': 1 })
    expect(told(shop)).toEqual({ 'FAKE-SKU-1': 16, 'FAKE-SKU-2': 4, 'FAKE-SKU-3': 1 })
    await expectInvariants()
  })

  it('2. a settings change pushes only to its Channel: buffer, limit, and a buffer larger than Available gives 0', async () => {
    const shopPushes = shop.stockPushes.length
    await updateChannelStockRules(ctx, org, connections.marketplace, { safetyBuffer: 2, channelLimit: 5 }, user)
    await drain()

    // SKU-1: 16 − 2 = 14, capped at 5. SKU-2: 4 − 2. SKU-3: 1 − 2 is below zero: 0.
    expect(told(marketplace)).toEqual({ 'FAKE-SKU-1': 5, 'FAKE-SKU-2': 2, 'FAKE-SKU-3': 0 })
    expect(shop.stockPushes).toHaveLength(shopPushes)
    expect(told(shop)).toEqual({ 'FAKE-SKU-1': 16, 'FAKE-SKU-2': 4, 'FAKE-SKU-3': 1 })
    await expectInvariants()
  })

  it('3. a Channel limit larger than Available tells the Channel Available', async () => {
    await updateChannelStockRules(ctx, org, connections.shop, { safetyBuffer: 0, channelLimit: 50 }, user)
    await drain()

    expect(told(shop)).toEqual({ 'FAKE-SKU-1': 16, 'FAKE-SKU-2': 4, 'FAKE-SKU-3': 1 })
    expect(told(marketplace)).toEqual({ 'FAKE-SKU-1': 5, 'FAKE-SKU-2': 2, 'FAKE-SKU-3': 0 })
    const offers = await ctx.db.offer.findMany({
      where: { organizationId: org, connectionId: connections.shop, productId: { not: null } },
      orderBy: { externalId: 'asc' },
    })
    expect(offers.map((offer) => offer.lastPushedAvailable)).toEqual([16, 4, 1])
    await expectInvariants()
  })

  it('4. a Stock change reaches both Channels, each with its own number', async () => {
    await setStock(ctx, org, products['FAKE-SKU-1']!, 7, user)
    await drain()

    // Available 7 − 4 = 3: the marketplace keeps its buffer of 2 back, the shop's limit of 50 does not bite.
    expect(await available()).toMatchObject({ 'FAKE-SKU-1': 3 })
    expect(told(marketplace)).toMatchObject({ 'FAKE-SKU-1': 1 })
    expect(told(shop)).toMatchObject({ 'FAKE-SKU-1': 3 })
    await expectInvariants()
  })

  it('5. a new Reservation on one Channel lowers the number told to both', async () => {
    shop.addOrder(newOrder('shop-order-1', 'FAKE-SKU-2', 1))
    await pullOrders(connections.shop)

    expect(await available()).toMatchObject({ 'FAKE-SKU-2': 3 })
    expect(told(marketplace)).toMatchObject({ 'FAKE-SKU-2': 1 })
    expect(told(shop)).toMatchObject({ 'FAKE-SKU-2': 3 })
    await expectInvariants()
  })

  it('6. an Order beyond Available is a Shortage as before, and no Channel is told a negative number', async () => {
    marketplace.addOrder(newOrder('marketplace-order-1', 'FAKE-SKU-2', 5))
    await pullOrders(connections.marketplace)

    const order = await ctx.db.order.findFirstOrThrow({
      where: { organizationId: org, connectionId: connections.marketplace, externalId: 'marketplace-order-1' },
      include: { lines: { include: { reservation: true } } },
    })
    // The Reservation is checked against the organization's Available (3), not against what the Channel was told.
    expect(order.lines.map((line) => [line.shortage, line.reservation?.status, line.reservation?.units])).toEqual([[true, 'open', 5]])
    expect(await available()).toMatchObject({ 'FAKE-SKU-2': -2 })
    expect(told(marketplace)).toMatchObject({ 'FAKE-SKU-2': 0 })
    expect(told(shop)).toMatchObject({ 'FAKE-SKU-2': 0 })
    await expectInvariants()

    await changeOrderStatus(ctx, org, order.id, 'cancelled', user)
    await drain()
    expect(await available()).toMatchObject({ 'FAKE-SKU-2': 3 })
    expect(told(marketplace)).toMatchObject({ 'FAKE-SKU-2': 1 })
    expect(told(shop)).toMatchObject({ 'FAKE-SKU-2': 3 })
    await expectInvariants()
  })

  it('7. removing the rules tells the marketplace Available again', async () => {
    await updateChannelStockRules(ctx, org, connections.marketplace, { safetyBuffer: 0, channelLimit: null }, user)
    await drain()

    expect(told(marketplace)).toEqual(await available())
    expect(told(shop)).toEqual(await available())
    await expectInvariants()
  })
})
