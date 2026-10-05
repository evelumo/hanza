import { createFakeChannel, type FakeChannel } from '@hanza/connector-fake'
import {
  addConnection,
  changeOrderStatus,
  coalesceKeys,
  createProduct,
  createWarehouse,
  getAvailability,
  getWarehouseAvailability,
  jobs,
  listWarehouses,
  moveReservation,
  ordersPullRef,
  setStock,
  updateChannelStockRules,
  updateChannelWarehouses,
  type Actor,
} from '@hanza/core'
import { createTestContext, createTestOrganization, type TestContext } from '@hanza/core/testing'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

const databaseUrl = inject('hanzaTestDatabaseUrl')
const user: Actor = { type: 'user', userId: 'user-1' }

type Order = Parameters<FakeChannel['addOrder']>[0]
const offerFor = { 'FAKE-SKU-1': 'fake-offer-1', 'FAKE-SKU-2': 'fake-offer-2', 'FAKE-SKU-3': 'fake-offer-3' } as const
type Sku = keyof typeof offerFor
const SKUS = Object.keys(offerFor) as Sku[]

/** The last number this Channel was told for each SKU's Offer. */
function told(channel: FakeChannel): Record<Sku, number | undefined> {
  const last = (offerExternalId: string) => {
    for (const levels of [...channel.stockPushes].reverse()) {
      const level = levels.find((candidate) => candidate.offerExternalId === offerExternalId)
      if (level) return level.available
    }
    return undefined
  }
  return Object.fromEntries(SKUS.map((sku) => [sku, last(offerFor[sku])])) as Record<Sku, number | undefined>
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

// Two Warehouses (main = the default, used first; north) and two fake Channels, each with its own
// Connection and the fake's seed (fake-order-1 reserves 2 × FAKE-SKU-1; fake-order-2 with SKU-2 and
// SKU-3 arrives cancelled). The marketplace counts both Warehouses and keeps a Safety buffer of 1
// with a Channel limit of 6 (#28); the shop counts only north and has no rules. A Channel is told what
// one of its Warehouses can cover: min(sum, largest) of their Available (ADR 0013), then its rules.
describe.skipIf(!databaseUrl)('multiple Warehouses end to end (real Postgres, in-memory queue, two fake Channels)', () => {
  let ctx: TestContext
  let marketplace: FakeChannel
  let shop: FakeChannel
  let org: string
  const connections = { marketplace: '', shop: '' }
  const products = {} as Record<Sku, string>
  const warehouses = { main: '', north: '' }

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

  async function pullOrders(connectionId: string) {
    await ctx.queue.enqueue(
      ordersPullRef,
      { organizationId: org, connectionId, trigger: 'schedule' },
      { coalesceKey: coalesceKeys.ordersPull(connectionId) },
    )
    await drain()
  }

  /** Available of each SKU in each Warehouse. */
  async function inWarehouses(): Promise<Record<Sku, { main: number; north: number }>> {
    const result = {} as Record<Sku, { main: number; north: number }>
    for (const sku of SKUS) {
      const map = await getWarehouseAvailability(ctx.db, org, products[sku], [warehouses.main, warehouses.north])
      result[sku] = { main: map.get(warehouses.main)!.available, north: map.get(warehouses.north)!.available }
    }
    return result
  }

  /** Stock rows of each SKU in each Warehouse. */
  async function stockRows(): Promise<Record<Sku, { main: number; north: number }>> {
    const rows = await ctx.db.stock.findMany({ where: { organizationId: org } })
    const of = (sku: Sku, warehouseId: string) => rows.find((row) => row.productId === products[sku] && row.warehouseId === warehouseId)?.units ?? 0
    return Object.fromEntries(SKUS.map((sku) => [sku, { main: of(sku, warehouses.main), north: of(sku, warehouses.north) }])) as Record<
      Sku,
      { main: number; north: number }
    >
  }

  /**
   * Every linked Offer is pushed; the marketplace is never told more than one of its Warehouses can cover,
   * the shop never more than north's, and nobody less than zero.
   */
  async function expectInvariants() {
    const now = await inWarehouses()
    for (const sku of SKUS) {
      const fromMarketplace = told(marketplace)[sku]!
      const fromShop = told(shop)[sku]!
      expect(fromMarketplace).toBeGreaterThanOrEqual(0)
      expect(fromShop).toBeGreaterThanOrEqual(0)
      const { main, north } = now[sku]
      // Never above what one Warehouse can cover, nor above the sum (owed units count).
      expect(fromMarketplace).toBeLessThanOrEqual(Math.max(0, Math.min(main + north, Math.max(main, north))))
      expect(fromShop).toBeLessThanOrEqual(Math.max(0, now[sku].north))
    }
    const offers = await ctx.db.offer.findMany({ where: { organizationId: org, productId: { not: null } } })
    expect(offers.every((offer) => offer.stockPushedSeq === offer.stockPushSeq)).toBe(true)
  }

  async function line(connectionId: string, externalId: string) {
    const order = await ctx.db.order.findFirstOrThrow({
      where: { organizationId: org, connectionId, externalId },
      include: { lines: { include: { reservation: true } } },
    })
    const [first] = order.lines
    return {
      orderId: order.id,
      lineId: first!.id,
      shortage: first!.shortage,
      reasons: order.attentionReasons,
      warehouse: first!.reservation?.warehouseId === warehouses.main ? 'main' : first!.reservation?.warehouseId === warehouses.north ? 'north' : null,
      status: first!.reservation?.status,
    }
  }

  it('1. each Channel is told what one of its own Warehouses can cover, with the buffer and limit on top', async () => {
    for (const [sku, stock] of [['FAKE-SKU-1', 10], ['FAKE-SKU-2', 0], ['FAKE-SKU-3', 3]] as const) {
      products[sku] = (await createProduct(ctx, org, { sku, name: sku, stock }, user)).productId
    }
    warehouses.main = (await listWarehouses(ctx, org))[0]!.id
    warehouses.north = (await createWarehouse(ctx, org, { name: 'North' }, user)).warehouseId
    await setStock(ctx, org, products['FAKE-SKU-1'], 4, user, warehouses.north)
    await setStock(ctx, org, products['FAKE-SKU-2'], 3, user, warehouses.north)

    const add = (connectorId: string, name: string) =>
      addConnection(ctx, org, { connectorId, name, config: { failMode: 'none' }, credentials: { apiKey: 'test' } }, user)
    connections.marketplace = (await add('fake', 'Marketplace')).connectionId
    connections.shop = (await add('fake-shop', 'Shop')).connectionId
    await updateChannelWarehouses(ctx, org, connections.shop, { all: false, warehouseIds: [warehouses.north] }, user)
    await updateChannelStockRules(ctx, org, connections.marketplace, { safetyBuffer: 1, channelLimit: 6 }, user)
    await drain()

    // fake-order-1 (2 × SKU-1): the marketplace's lands in main (first, enough), the shop's in north (its only one).
    expect(await line(connections.marketplace, 'fake-order-1')).toMatchObject({ warehouse: 'main', shortage: false })
    expect(await line(connections.shop, 'fake-order-1')).toMatchObject({ warehouse: 'north', shortage: false })
    expect(await inWarehouses()).toEqual({
      'FAKE-SKU-1': { main: 8, north: 2 },
      'FAKE-SKU-2': { main: 0, north: 3 },
      'FAKE-SKU-3': { main: 3, north: 0 },
    })
    // Marketplace: min(min(8 + 2, 8) − 1, 6), 3 − 1, 3 − 1. Shop: north only.
    expect(told(marketplace)).toEqual({ 'FAKE-SKU-1': 6, 'FAKE-SKU-2': 2, 'FAKE-SKU-3': 2 })
    expect(told(shop)).toEqual({ 'FAKE-SKU-1': 2, 'FAKE-SKU-2': 3, 'FAKE-SKU-3': 0 })
    await expectInvariants()
  })

  it('2. an imported Order reserves in the first Warehouse that covers it, and both Channels\' numbers move', async () => {
    marketplace.addOrder(newOrder('marketplace-order-1', 'FAKE-SKU-2', 3))
    await pullOrders(connections.marketplace)

    // Main has no SKU-2, north has 3: north.
    expect(await line(connections.marketplace, 'marketplace-order-1')).toMatchObject({ warehouse: 'north', shortage: false, status: 'open' })
    expect((await inWarehouses())['FAKE-SKU-2']).toEqual({ main: 0, north: 0 })
    expect(told(marketplace)).toMatchObject({ 'FAKE-SKU-2': 0 })
    expect(told(shop)).toMatchObject({ 'FAKE-SKU-2': 0 })
    await expectInvariants()
  })

  it('3. a Shortage arises when the Channel\'s Warehouses cannot cover the line, even though another Warehouse could', async () => {
    shop.addOrder(newOrder('shop-order-1', 'FAKE-SKU-3', 1))
    await pullOrders(connections.shop)

    // Main holds 3 × SKU-3, but the shop counts only north (0): a Shortage in north.
    expect(await line(connections.shop, 'shop-order-1')).toMatchObject({ warehouse: 'north', shortage: true, reasons: ['shortage'] })
    expect((await inWarehouses())['FAKE-SKU-3']).toEqual({ main: 3, north: -1 })
    // The same line from the marketplace is covered by main.
    marketplace.addOrder(newOrder('marketplace-order-2', 'FAKE-SKU-3', 1))
    await pullOrders(connections.marketplace)
    expect(await line(connections.marketplace, 'marketplace-order-2')).toMatchObject({ warehouse: 'main', shortage: false, reasons: [] })
    expect((await inWarehouses())['FAKE-SKU-3']).toEqual({ main: 2, north: -1 })
    // Marketplace: 2 + (−1) − 1; the shop is never told a negative number.
    expect(told(marketplace)).toMatchObject({ 'FAKE-SKU-3': 0 })
    expect(told(shop)).toMatchObject({ 'FAKE-SKU-3': 0 })
    await expectInvariants()
  })

  it('4. Stock set in one Warehouse reaches only the Channels counting it with a new number', async () => {
    await setStock(ctx, org, products['FAKE-SKU-2'], 5, user, warehouses.main)
    await drain()

    expect((await inWarehouses())['FAKE-SKU-2']).toEqual({ main: 5, north: 0 })
    expect(told(marketplace)).toMatchObject({ 'FAKE-SKU-2': 4 })
    expect(told(shop)).toMatchObject({ 'FAKE-SKU-2': 0 })
    await expectInvariants()
  })

  it('5. moving a Reservation pushes both Channels, each with its own number', async () => {
    const { lineId } = await line(connections.marketplace, 'marketplace-order-1')
    const pushes = { marketplace: marketplace.stockPushes.length, shop: shop.stockPushes.length }
    await moveReservation(ctx, org, lineId, warehouses.main, user)
    await drain()

    expect(await line(connections.marketplace, 'marketplace-order-1')).toMatchObject({ warehouse: 'main', status: 'open' })
    expect((await inWarehouses())['FAKE-SKU-2']).toEqual({ main: 2, north: 3 })
    expect(marketplace.stockPushes.length).toBeGreaterThan(pushes.marketplace)
    expect(shop.stockPushes.length).toBeGreaterThan(pushes.shop)
    // Main 2, north 3: the marketplace is told min(5, 3) − 1 (one line can get at most 3); the shop sees north's 3 again.
    expect(told(marketplace)).toMatchObject({ 'FAKE-SKU-2': 2 })
    expect(told(shop)).toMatchObject({ 'FAKE-SKU-2': 3 })

    // Moving the shop's short SKU-3 line to main clears its Shortage.
    const short = await line(connections.shop, 'shop-order-1')
    await moveReservation(ctx, org, short.lineId, warehouses.main, user)
    await drain()
    expect(await line(connections.shop, 'shop-order-1')).toMatchObject({ warehouse: 'main', shortage: false, reasons: [] })
    expect((await inWarehouses())['FAKE-SKU-3']).toEqual({ main: 1, north: 0 })
    expect(told(marketplace)).toMatchObject({ 'FAKE-SKU-3': 0 })
    expect(told(shop)).toMatchObject({ 'FAKE-SKU-3': 0 })
    await expectInvariants()
  })

  it('6. changing a Channel\'s Warehouses pushes that Channel only', async () => {
    const marketplacePushes = marketplace.stockPushes.length
    await updateChannelWarehouses(ctx, org, connections.shop, { all: true }, user)
    await drain()

    expect(marketplace.stockPushes).toHaveLength(marketplacePushes)
    const now = await inWarehouses()
    // Without rules the shop is now told min(sum, largest) of main and north.
    const coverable = (sku: Sku) => Math.max(0, Math.min(now[sku].main + now[sku].north, Math.max(now[sku].main, now[sku].north)))
    expect(told(shop)).toEqual(Object.fromEntries(SKUS.map((sku) => [sku, coverable(sku)])))
    expect(told(shop)).toEqual({ 'FAKE-SKU-1': 8, 'FAKE-SKU-2': 3, 'FAKE-SKU-3': 1 })

    await updateChannelWarehouses(ctx, org, connections.shop, { all: false, warehouseIds: [warehouses.north] }, user)
    await drain()
    expect(told(shop)).toEqual({ 'FAKE-SKU-1': 2, 'FAKE-SKU-2': 3, 'FAKE-SKU-3': 0 })
    expect(marketplace.stockPushes).toHaveLength(marketplacePushes)
    await expectInvariants()
  })

  it('7. ship and cancel consume and release in the Reservation\'s own Warehouse', async () => {
    const before = await stockRows()
    const shipped = await line(connections.marketplace, 'marketplace-order-1')
    await changeOrderStatus(ctx, org, shipped.orderId, 'shipped', user)
    const cancelled = await line(connections.shop, 'fake-order-1')
    await changeOrderStatus(ctx, org, cancelled.orderId, 'cancelled', user)
    await drain()

    const after = await stockRows()
    // 3 × SKU-2 consumed in main (where it was moved); north untouched.
    expect(after['FAKE-SKU-2']).toEqual({ main: before['FAKE-SKU-2'].main - 3, north: before['FAKE-SKU-2'].north })
    // The shop's 2 × SKU-1 released in north: Stock unchanged, north's Available back up.
    expect(after['FAKE-SKU-1']).toEqual(before['FAKE-SKU-1'])
    expect(await inWarehouses()).toMatchObject({ 'FAKE-SKU-1': { main: 8, north: 4 }, 'FAKE-SKU-2': { main: 2, north: 3 } })
    expect(told(shop)).toMatchObject({ 'FAKE-SKU-1': 4, 'FAKE-SKU-2': 3 })
    expect(told(marketplace)).toMatchObject({ 'FAKE-SKU-1': 6, 'FAKE-SKU-2': 2 })
    await expectInvariants()
  })

  it('8. an organization with one Warehouse behaves as before: everything in the default Warehouse, Channels told Available', async () => {
    const single = createFakeChannel()
    const singleCtx = createTestContext({ databaseUrl: databaseUrl!, connectors: [single.connector] })
    try {
      const singleOrg = await createTestOrganization(singleCtx.db)
      const ids: string[] = []
      for (const [sku, stock] of [['FAKE-SKU-1', 1], ['FAKE-SKU-2', 4], ['FAKE-SKU-3', 0]] as const) {
        ids.push((await createProduct(singleCtx, singleOrg, { sku, name: sku, stock }, user)).productId)
      }
      const { connectionId } = await addConnection(
        singleCtx,
        singleOrg,
        { connectorId: 'fake', name: 'Only', config: { failMode: 'none' }, credentials: { apiKey: 'test' } },
        user,
      )
      const result = await singleCtx.queue.drain(singleCtx, jobs)
      expect(result.failed).toEqual([])

      const [main] = await listWarehouses(singleCtx, singleOrg)
      const reservations = await singleCtx.db.reservation.findMany({ where: { organizationId: singleOrg } })
      expect(reservations.length).toBeGreaterThan(0)
      expect(reservations.every((reservation) => reservation.warehouseId === main!.id)).toBe(true)
      // fake-order-1 wants 2 × SKU-1 against Available 1: a Shortage, exactly as the old rule says.
      const order = await singleCtx.db.order.findFirstOrThrow({
        where: { organizationId: singleOrg, connectionId, externalId: 'fake-order-1' },
        include: { lines: true },
      })
      expect(order.lines.map((orderLine) => orderLine.shortage)).toEqual([true])
      const availability = await getAvailability(singleCtx.db, singleOrg, ids)
      expect(told(single)).toEqual({
        'FAKE-SKU-1': Math.max(0, availability.get(ids[0]!)!.available),
        'FAKE-SKU-2': Math.max(0, availability.get(ids[1]!)!.available),
        'FAKE-SKU-3': Math.max(0, availability.get(ids[2]!)!.available),
      })
      expect(told(single)).toEqual({ 'FAKE-SKU-1': 0, 'FAKE-SKU-2': 4, 'FAKE-SKU-3': 0 })
    } finally {
      await singleCtx.db.$disconnect()
    }
  })
})
