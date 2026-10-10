import type { ChannelFact, Order, OrderUpdate } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { upsertOffers } from '../catalog/offers'
import { createProduct } from '../catalog/products'
import { getAvailability } from '../stock/availability'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, createTestConnection, fact, orderLine, testChannel, uniqueSku, user } from '../testing/fixtures'
import { changeOrderStatus } from './change-status'
import { importOrder } from './import'
import { applyOrderUpdate } from './update'

// A new Channel fact for an Order Hanza has marks that Order's Offers on its own Connection for a stock push, also
// when it moved no Stock: the Channel may have changed its own count with what it reports (ADR 0023).

/** How the feed reports facts for an Order Hanza has: the whole Order again, or an Order update. */
const ways = ['a full Order', 'an Order update'] as const

describe.skipIf(!databaseUrl)('a Channel fact and the stock push', () => {
  const context = useTestContext({ connectors: [testChannel] })

  /** Two Channels sell the same Product; Channel A also sells another one. One Order of the Product on Channel A. */
  async function setup(overrides: Partial<Order> = {}) {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const sku = uniqueSku()
    const otherSku = uniqueSku()
    const { productId } = await createProduct(ctx, org, { sku, name: 'Product', stock: 10 }, user)
    await createProduct(ctx, org, { sku: otherSku, name: 'Other', stock: 10 }, user)
    const a = await createTestConnection(ctx, org, 'A')
    const b = await createTestConnection(ctx, org, 'B')
    const offer = (externalId: string, offerSku: string) => ({ externalId, sku: offerSku, name: externalId, url: null })
    await upsertOffers(ctx, org, a, [offer('product', sku), offer('other', otherSku)], new Date())
    await upsertOffers(ctx, org, b, [offer('product', sku)], new Date())
    const order = buildOrder({ lines: [orderLine('l1', { offerExternalId: 'product', sku, quantity: 2 })], ...overrides })
    const { orderId } = await importOrder(ctx, org, a, order)
    ctx.queue.waiting.splice(0)

    /** Push sequence per Offer, as `<channel>/<offer>`. */
    const sequences = async () => {
      const offers = await ctx.db.offer.findMany({ where: { organizationId: org }, select: { connectionId: true, externalId: true, stockPushSeq: true } })
      return Object.fromEntries(offers.map((row) => [`${row.connectionId === a ? 'a' : 'b'}/${row.externalId}`, row.stockPushSeq]))
    }
    /** The stock pushes requested since the last look, by Channel. */
    const requested = () =>
      ctx.queue.waiting
        .splice(0)
        .filter((job) => job.name === 'stock.push')
        .map((job) => ((job.payload as { connectionId: string }).connectionId === a ? 'a' : 'b'))
        .sort()
    const report = async (way: (typeof ways)[number], facts: ChannelFact[], snapshot: Partial<Order> = {}) =>
      way === 'a full Order'
        ? (await importOrder(ctx, org, a, { ...order, ...snapshot, facts })).factsApplied
        : (((await applyOrderUpdate(ctx, org, a, { kind: 'update', externalId: order.externalId, facts })) as { factsApplied: number }).factsApplied)
    const available = async () => (await getAvailability(ctx.db, org, [productId])).get(productId)
    return { ctx, org, a, b, order, orderId, sequences, requested, report, available }
  }

  it.each(ways)('a paid fact in %s moves no Stock and marks the Offers of this Connection only; reported again, nothing', async (way) => {
    const t = await setup({ awaitingPayment: true })
    const before = await t.sequences()
    const availableBefore = await t.available()

    expect(await t.report(way, [fact('paid-1', 'paid')], { awaitingPayment: false })).toBe(1)
    expect(await t.available()).toEqual(availableBefore)
    // Not Channel A's other Offer, and not the same Product on Channel B: that Channel counted nothing.
    expect(await t.sequences()).toEqual({ ...before, 'a/product': before['a/product']! + 1 })
    expect(t.requested()).toEqual(['a'])

    // The feed returns the same Order often (a shop stamps a change when Hanza pushes a status).
    expect(await t.report(way, [fact('paid-1', 'paid')], { awaitingPayment: false })).toBe(0)
    expect(await t.sequences()).toEqual({ ...before, 'a/product': before['a/product']! + 1 })
    expect(t.requested()).toEqual([])
  })

  it.each(ways)('a cancelled fact in %s for an Order a person cancelled in Hanza marks them too', async (way) => {
    const t = await setup()
    await changeOrderStatus(t.ctx, t.org, t.orderId, 'cancelled', user)
    t.requested()
    const before = await t.sequences()

    expect(await t.report(way, [fact('cancelled-1', 'cancelled')])).toBe(1)
    expect(await t.sequences()).toEqual({ ...before, 'a/product': before['a/product']! + 1 })
    expect(t.requested()).toEqual(['a'])
  })

  it.each(ways)('a shipped fact in %s for an Order a person shipped in Hanza marks them too', async (way) => {
    const t = await setup()
    await changeOrderStatus(t.ctx, t.org, t.orderId, 'shipped', user)
    t.requested()
    const before = await t.sequences()

    expect(await t.report(way, [fact('shipped-1', 'shipped')])).toBe(1)
    expect(await t.sequences()).toEqual({ ...before, 'a/product': before['a/product']! + 1 })
    expect(t.requested()).toEqual(['a'])
  })

  it.each(ways)('a fact in %s that moves Stock marks the Product on every Channel, each Offer once', async (way) => {
    const t = await setup()
    const before = await t.sequences()

    expect(await t.report(way, [fact('cancelled-1', 'cancelled')])).toBe(1)
    expect(await t.available()).toEqual({ stock: 10, reserved: 0, available: 10 })
    expect(await t.sequences()).toEqual({ ...before, 'a/product': before['a/product']! + 1, 'b/product': before['b/product']! + 1 })
    expect(t.requested()).toEqual(['a', 'b'])
  })

  it('an Order that comes back with nothing new, or an update with addresses alone, marks nothing', async () => {
    const t = await setup()
    const before = await t.sequences()

    expect(await t.report('a full Order', [])).toBe(0)
    expect(await t.report('an Order update', [])).toBe(0)
    const addresses: OrderUpdate = { kind: 'update', externalId: t.order.externalId, facts: [], shippingAddress: t.order.shippingAddress }
    expect(await applyOrderUpdate(t.ctx, t.org, t.a, addresses)).toMatchObject({ found: true, factsApplied: 0 })
    expect(await t.sequences()).toEqual(before)
    expect(t.requested()).toEqual([])
  })

  it("a fact for another organization's Order of the same external id marks nothing here", async () => {
    const t = await setup({ awaitingPayment: true })
    const before = await t.sequences()
    const other = await createTestOrganization(t.ctx.db)
    const otherConnection = await createTestConnection(t.ctx, other)
    await importOrder(t.ctx, other, otherConnection, { ...t.order, awaitingPayment: true })
    await importOrder(t.ctx, other, otherConnection, { ...t.order, awaitingPayment: false, facts: [fact('paid-1', 'paid')] })
    expect(await t.sequences()).toEqual(before)
    expect(t.requested()).toEqual([])
  })
})
