import { describe, expect, it } from 'vitest'
import {
  createProduct,
  createProductsFromOffers,
  findProductBySku,
  getOffer,
  getProduct,
  linkOffer,
  listOffers,
  listOffersAwaitingStockPush,
  listProducts,
  markOffersPushed,
  unlinkOffer,
  updateProduct,
  upsertOffers,
} from './catalog/index'
import {
  failSyncRun,
  finishSyncRun,
  getConnection,
  listConnections,
  openConnection,
  saveSyncCursor,
  startSyncRun,
  updateChannelStockRules,
} from './connections/index'
import { listEvents } from './events'
import {
  changeOrderStatus,
  getOrder,
  importOrder,
  linkOrderLine,
  listOrders,
  rematchUnmatchedLines,
  resolveAttention,
} from './orders/index'
import { listOffersAwaitingPricePush, markOffersPriceHandled, setBasePrice, setOfferPrice } from './prices/index'
import { ensureDefaultWarehouse, getAvailability, getChannelAvailability, setStock } from './stock/index'
import { createTestOrganization } from './testing/context'
import { databaseUrl, useTestContext } from './testing/db-test'
import { buildOrder, createTestConnection, orderLine, user } from './testing/fixtures'

describe.skipIf(!databaseUrl)('tenant isolation: another organization\'s ids', () => {
  const context = useTestContext()

  it('every service refuses or returns nothing, and leaves the owner\'s data unchanged', async () => {
    const ctx = context()
    const a = await createTestOrganization(ctx.db)
    const b = await createTestOrganization(ctx.db)
    const connA = await createTestConnection(ctx, a)
    const connB = await createTestConnection(ctx, b)
    const productA = (await createProduct(ctx, a, { sku: 'SHARED', name: 'A', stock: 5 }, user)).productId
    await upsertOffers(ctx, a, connA, [{ externalId: 'oa', sku: 'SHARED', name: 'Offer A', url: null }], new Date())
    const offerA = (await ctx.db.offer.findFirstOrThrow({ where: { organizationId: a } })).id
    const orderA = (await importOrder(ctx, a, connA, buildOrder({ lines: [orderLine('l1', { sku: 'SHARED' }), orderLine('l2', { sku: 'LATER' })] }))).orderId
    const lineA = (await ctx.db.orderLine.findFirstOrThrow({ where: { orderId: orderA, externalId: 'l2' } })).id
    // B has Products with the same SKUs; they must never be matched to A's lines.
    const productB = (await createProduct(ctx, b, { sku: 'LATER', name: 'B', stock: 1 }, user)).productId
    const snapshot = async () => ({
      eventCount: await ctx.db.eventLog.count({ where: { organizationId: a } }),
      product: await ctx.db.product.findFirstOrThrow({ where: { id: productA } }),
      offer: await ctx.db.offer.findFirstOrThrow({ where: { id: offerA } }),
      order: await ctx.db.order.findFirstOrThrow({ where: { id: orderA }, include: { lines: { include: { reservation: true } } } }),
      stock: await ctx.db.stock.findMany({ where: { organizationId: a } }),
      sync: await ctx.db.syncState.findMany({ where: { organizationId: a } }),
      connection: await ctx.db.connection.findFirstOrThrow({ where: { id: connA } }),
    })
    const before = await snapshot()
    const notFound = { code: 'not_found' }

    // Catalog
    await expect(updateProduct(ctx, b, productA, { name: 'X' }, user)).rejects.toMatchObject(notFound)
    expect(await findProductBySku(ctx, b, 'SHARED')).toBeNull()
    expect((await listProducts(ctx, b, { skip: 0, take: 50 })).items.map((item) => item.id)).toEqual([productB])
    expect(await getProduct(ctx, b, productA)).toBeNull()
    expect(await createProductsFromOffers(ctx, b, [offerA], user)).toEqual({ created: [], skipped: [{ offerId: offerA, reason: 'not_found' }] })
    await expect(upsertOffers(ctx, b, connA, [{ externalId: 'oa', sku: null, name: 'X', url: null }], new Date())).rejects.toMatchObject(notFound)
    await expect(linkOffer(ctx, b, offerA, productB, user)).rejects.toMatchObject(notFound)
    await expect(linkOffer(ctx, a, offerA, productB, user)).rejects.toMatchObject(notFound)
    await expect(unlinkOffer(ctx, b, offerA, user)).rejects.toMatchObject(notFound)
    expect((await listOffers(ctx, b, { skip: 0, take: 50 })).total).toBe(0)
    expect(await listOffersAwaitingStockPush(ctx, b, connA, 100)).toEqual([])
    await markOffersPushed(ctx, b, [{ offerId: offerA, seq: 99, available: 99 }])
    expect(await getOffer(ctx, b, offerA)).toBeNull()

    // Prices
    const price = { amount: '1', currency: 'PLN' }
    await expect(setBasePrice(ctx, b, productA, price, user)).rejects.toMatchObject(notFound)
    await expect(setOfferPrice(ctx, b, offerA, price, user)).rejects.toMatchObject(notFound)
    expect(await listOffersAwaitingPricePush(ctx, b, connA, 100)).toEqual([])
    await markOffersPriceHandled(ctx, b, [{ offerId: offerA, seq: 99, pushed: price }])

    // Stock
    await expect(setStock(ctx, b, productA, 0, user)).rejects.toMatchObject(notFound)
    expect((await getAvailability(ctx.db, b, [productA])).get(productA)).toEqual({ stock: 0, reserved: 0, available: 0 })
    expect(await ensureDefaultWarehouse(ctx.db, b)).not.toBe(await ensureDefaultWarehouse(ctx.db, a))
    expect(await getChannelAvailability(ctx.db, b, connA, [productA])).toEqual(new Map())

    // Orders
    await expect(importOrder(ctx, b, connA, buildOrder())).rejects.toMatchObject(notFound)
    await expect(changeOrderStatus(ctx, b, orderA, 'cancelled', user)).rejects.toMatchObject(notFound)
    await expect(linkOrderLine(ctx, b, lineA, productB, user)).rejects.toMatchObject(notFound)
    await expect(linkOrderLine(ctx, a, lineA, productB, user)).rejects.toMatchObject(notFound)
    await expect(resolveAttention(ctx, b, orderA, user)).rejects.toMatchObject(notFound)
    expect(await rematchUnmatchedLines(ctx, b)).toEqual({ linked: 0 })
    expect((await listOrders(ctx, b, { skip: 0, take: 50 })).total).toBe(0)
    expect(await getOrder(ctx, b, orderA)).toBeNull()

    // Connections
    expect((await listConnections(ctx, b)).map((connection) => connection.id)).toEqual([connB])
    expect(await getConnection(ctx, b, connA)).toBeNull()
    expect(await openConnection(ctx, b, connA)).toBeNull()
    await expect(updateChannelStockRules(ctx, b, connA, { safetyBuffer: 1, channelLimit: 1 }, user)).rejects.toMatchObject(notFound)
    await expect(startSyncRun(ctx, b, connA, 'orders_pull')).rejects.toMatchObject(notFound)
    await expect(saveSyncCursor(ctx, b, connA, 'orders_pull', '9')).rejects.toMatchObject(notFound)
    await expect(finishSyncRun(ctx, b, connA, 'orders_pull', {})).rejects.toMatchObject(notFound)
    await expect(failSyncRun(ctx, b, connA, 'orders_pull', { kind: 'permanent', message: 'x', health: 'failing' })).rejects.toMatchObject(notFound)

    // Events
    expect(await listEvents(ctx, b, { type: 'order', id: orderA }, 50)).toEqual([])
    expect((await listEvents(ctx, a, { type: 'order', id: orderA }, 50)).length).toBeGreaterThan(0)

    expect(await snapshot()).toEqual(before)
  })
})
