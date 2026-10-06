import { describe, expect, it } from 'vitest'
import { linkOffer, upsertOffers } from './catalog/offers'
import { createProduct } from './catalog/products'
import type { Context } from './context'
import { changeOrderStatus } from './orders/change-status'
import { importOrder } from './orders/import'
import { linkOrderLine } from './orders/link-line'
import { getAvailability } from './stock/availability'
import { setStock } from './stock/set-stock'
import { createTestOrganization, type TestContext } from './testing/context'
import { databaseUrl, useTestContext } from './testing/db-test'
import { buildOrder, createTestConnection, orderLine, testChannel, user } from './testing/fixtures'

// The queue is down after commit: the change is durable, so the operation must
// succeed anyway and only log what it could not enqueue (ids, no personal data).

function withBrokenQueue(ctx: TestContext) {
  const logged: Array<Record<string, unknown>> = []
  const broken: Context = {
    ...ctx,
    queue: {
      ...ctx.queue,
      enqueue: async () => {
        throw new Error('Redis unavailable')
      },
    },
    log: { info() {}, warn() {}, error: (message, fields) => logged.push({ message, ...fields }) },
  }
  return { broken, logged }
}

describe.skipIf(!databaseUrl)('post-commit enqueue failures', () => {
  const context = useTestContext({ connectors: [testChannel] })

  async function setup() {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const connectionId = await createTestConnection(ctx, org)
    await upsertOffers(ctx, org, connectionId, [{ externalId: 'offer-p', sku: 'P', name: 'Offer', url: null }], new Date())
    const { productId } = await createProduct(ctx, org, { sku: 'P', name: 'Product', stock: 5 }, user)
    const stockPushFailure = { message: 'post-commit step failed', job: 'stock.push', organizationId: org, connectionId, error: 'Redis unavailable' }
    const pricePushFailure = { ...stockPushFailure, job: 'price.push' }
    return { ctx, org, connectionId, productId, stockPushFailure, pricePushFailure, ...withBrokenQueue(ctx) }
  }

  it('changeOrderStatus succeeds, changes the Order and logs both failed enqueues', async () => {
    const { ctx, org, connectionId, productId, broken, logged, stockPushFailure } = await setup()
    const order = buildOrder({ lines: [orderLine('l1', { sku: 'P', quantity: 2 })] })
    const { orderId } = await importOrder(ctx, org, connectionId, order)

    await expect(changeOrderStatus(broken, org, orderId, 'shipped', user)).resolves.toBeUndefined()

    expect((await ctx.db.order.findFirstOrThrow({ where: { id: orderId } })).phase).toBe('shipped')
    expect((await getAvailability(ctx.db, org, [productId])).get(productId)).toEqual({ stock: 3, reserved: 0, available: 3 })
    expect(logged).toEqual([
      stockPushFailure,
      { message: 'post-commit step failed', job: 'orders.updateStatus', organizationId: org, orderId, error: 'Redis unavailable' },
    ])
    const text = JSON.stringify(logged)
    for (const personal of [order.buyer.name, order.buyer.email!, order.shippingAddress.street]) expect(text).not.toContain(personal)
  })

  it('createProduct succeeds, links the Offer and rematches the line despite failed stock and price pushes', async () => {
    const { ctx, org, connectionId, broken, logged, stockPushFailure, pricePushFailure } = await setup()
    await upsertOffers(ctx, org, connectionId, [{ externalId: 'offer-new', sku: 'NEW', name: 'Newer', url: null }], new Date())
    const { orderId } = await importOrder(ctx, org, connectionId, buildOrder({ lines: [orderLine('l1', { sku: 'NEW' })] }))

    const { productId } = await createProduct(broken, org, { sku: 'NEW', name: 'New', stock: 1 }, user)

    expect(await ctx.db.offer.findFirstOrThrow({ where: { organizationId: org, externalId: 'offer-new' } })).toMatchObject({ productId })
    expect((await ctx.db.orderLine.findFirstOrThrow({ where: { orderId } })).productId).toBe(productId)
    // Stock and price for the Product's own commit (it linked the Offer), stock again for the rematch's.
    expect(logged).toEqual([stockPushFailure, pricePushFailure, stockPushFailure])
  })

  it('setStock, importOrder, linkOffer and linkOrderLine succeed and log the failed stock (and price) push', async () => {
    const { ctx, org, connectionId, productId, broken, logged, stockPushFailure, pricePushFailure } = await setup()
    await upsertOffers(ctx, org, connectionId, [{ externalId: 'offer-x', sku: null, name: 'X', url: null }], new Date())

    await setStock(broken, org, productId, 9, user)
    expect((await getAvailability(ctx.db, org, [productId])).get(productId)?.stock).toBe(9)

    const { orderId } = await importOrder(broken, org, connectionId, buildOrder({ lines: [orderLine('l1', { sku: 'P' }), orderLine('l2', { sku: 'NOPE' })] }))
    expect(await ctx.db.reservation.count({ where: { organizationId: org } })).toBe(1)

    const offerX = await ctx.db.offer.findFirstOrThrow({ where: { organizationId: org, externalId: 'offer-x' } })
    await linkOffer(broken, org, offerX.id, productId, user)
    expect((await ctx.db.offer.findFirstOrThrow({ where: { id: offerX.id } })).productId).toBe(productId)

    const unmatched = await ctx.db.orderLine.findFirstOrThrow({ where: { orderId, productId: null } })
    await linkOrderLine(broken, org, unmatched.id, productId, user)
    expect((await ctx.db.orderLine.findFirstOrThrow({ where: { id: unmatched.id } })).productId).toBe(productId)

    expect(logged).toEqual([stockPushFailure, stockPushFailure, stockPushFailure, pricePushFailure, stockPushFailure])
  })
})
