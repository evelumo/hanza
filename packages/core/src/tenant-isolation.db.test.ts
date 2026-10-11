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
  updateChannelWarehouses,
} from './connections/index'
import { listEvents } from './events'
import { shipmentsCreateJob } from './jobs/shipments-create'
import { shipmentsTrackJob } from './jobs/shipments-track'
import {
  changeOrderStatus,
  getOrder,
  importOrder,
  linkOrderLine,
  listOrders,
  moveReservation,
  rematchUnmatchedLines,
  resolveAttention,
} from './orders/index'
import { listOffersAwaitingPricePush, markOffersPriceHandled, setBasePrice, setOfferPrice } from './prices/index'
import { applyShipmentState, failShipment } from './shipments/apply-state'
import { cancelShipment, getShipmentLabel, listOrderShipments, listShippingConnections, requestShipment } from './shipments/index'
import {
  channelWarehouseIds,
  ensureDefaultWarehouse,
  getAvailability,
  getAvailabilityByWarehouse,
  getChannelAvailability,
  getWarehouseAvailability,
  setStock,
} from './stock/index'
import { createTestCarrier } from './testing/carrier'
import { createTestOrganization } from './testing/context'
import { databaseUrl, useTestContext } from './testing/db-test'
import { buildOrder, createCarrierConnection, createTestConnection, jobRun, lockerShipment, orderLine, user } from './testing/fixtures'
import { createWarehouse, deleteWarehouse, getWarehouse, listWarehouses, setWarehouseActive, updateWarehouse } from './warehouses/index'

const carrier = createTestCarrier({ id: 'isolation-carrier' })

describe.skipIf(!databaseUrl)('tenant isolation: another organization\'s ids', () => {
  const context = useTestContext({ connectors: [carrier.connector] })

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
    const reservedLineA = (await ctx.db.orderLine.findFirstOrThrow({ where: { orderId: orderA, externalId: 'l1' } })).id
    const defaultWarehouseA = await ensureDefaultWarehouse(ctx.db, a)
    const spareWarehouseA = (await createWarehouse(ctx, a, { name: 'Spare A' }, user)).warehouseId
    // B has Products with the same SKUs; they must never be matched to A's lines.
    const productB = (await createProduct(ctx, b, { sku: 'LATER', name: 'B', stock: 1 }, user)).productId
    // A has a Shipment the Carrier confirmed, with a Label; B has a Carrier Connection and an Order of its own.
    const carrierA = await createCarrierConnection(ctx, a, 'isolation-carrier')
    const carrierB = await createCarrierConnection(ctx, b, 'isolation-carrier')
    const orderB = (await importOrder(ctx, b, connB, buildOrder())).orderId
    const shipmentA = (await requestShipment(ctx, a, orderA, lockerShipment(carrierA), user)).shipmentId
    await shipmentsCreateJob.handler(ctx, { organizationId: a, shipmentId: shipmentA }, jobRun)
    const atCarrier = carrier.byReference(shipmentA)!
    carrier.advance(atCarrier.externalId, 'ready')
    await ctx.db.$executeRaw`UPDATE "shipment" SET "nextCheckAt" = now() - interval '1 second' WHERE "id" = ${shipmentA}`
    await shipmentsTrackJob.handler(ctx, { organizationId: a, connectionId: carrierA }, jobRun)
    await ctx.db.$executeRaw`UPDATE "shipment" SET "nextCheckAt" = now() - interval '1 second' WHERE "id" = ${shipmentA}`
    ctx.queue.waiting.length = 0
    const snapshot = async () => ({
      eventCount: await ctx.db.eventLog.count({ where: { organizationId: a } }),
      product: await ctx.db.product.findFirstOrThrow({ where: { id: productA } }),
      offer: await ctx.db.offer.findFirstOrThrow({ where: { id: offerA } }),
      order: await ctx.db.order.findFirstOrThrow({ where: { id: orderA }, include: { lines: { include: { reservation: true } } } }),
      stock: await ctx.db.stock.findMany({ where: { organizationId: a } }),
      sync: await ctx.db.syncState.findMany({ where: { organizationId: a } }),
      connection: await ctx.db.connection.findFirstOrThrow({ where: { id: connA } }),
      warehouses: await ctx.db.warehouse.findMany({ where: { organizationId: a }, orderBy: { id: 'asc' } }),
      channelWarehouses: await ctx.db.connectionWarehouse.findMany({ where: { organizationId: a } }),
      shipments: await ctx.db.shipment.findMany({ where: { organizationId: a } }),
      carrierCalls: { create: carrier.calls.create.length, track: carrier.calls.track.length, label: carrier.calls.label.length, cancel: carrier.calls.cancel.length },
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
    const warehouseB = await ensureDefaultWarehouse(ctx.db, b)
    await expect(setStock(ctx, b, productA, 0, user, defaultWarehouseA)).rejects.toMatchObject(notFound)
    await expect(setStock(ctx, a, productA, 9, user, warehouseB)).rejects.toMatchObject(notFound)
    expect(await channelWarehouseIds(ctx.db, b, connA)).toEqual([])
    const zero = { stock: 0, reserved: 0, available: 0 }
    expect((await getWarehouseAvailability(ctx.db, b, productA, [defaultWarehouseA])).get(defaultWarehouseA)).toEqual(zero)
    expect((await getAvailabilityByWarehouse(ctx.db, b, [productA], [defaultWarehouseA])).get(productA)?.get(defaultWarehouseA)).toEqual(zero)

    // Warehouses
    expect((await listWarehouses(ctx, b)).map((warehouse) => warehouse.id)).toEqual([warehouseB])
    expect(await getWarehouse(ctx, b, spareWarehouseA)).toBeNull()
    await expect(updateWarehouse(ctx, b, spareWarehouseA, { name: 'X', priority: 7 }, user)).rejects.toMatchObject(notFound)
    await expect(setWarehouseActive(ctx, b, spareWarehouseA, false, user)).rejects.toMatchObject(notFound)
    await expect(deleteWarehouse(ctx, b, spareWarehouseA, user)).rejects.toMatchObject(notFound)

    // Orders
    await expect(importOrder(ctx, b, connA, buildOrder())).rejects.toMatchObject(notFound)
    await expect(changeOrderStatus(ctx, b, orderA, 'cancelled', user)).rejects.toMatchObject(notFound)
    await expect(linkOrderLine(ctx, b, lineA, productB, user)).rejects.toMatchObject(notFound)
    await expect(linkOrderLine(ctx, a, lineA, productB, user)).rejects.toMatchObject(notFound)
    await expect(moveReservation(ctx, b, reservedLineA, warehouseB, user)).rejects.toMatchObject(notFound)
    await expect(moveReservation(ctx, a, reservedLineA, warehouseB, user)).rejects.toMatchObject(notFound)
    await expect(resolveAttention(ctx, b, orderA, user)).rejects.toMatchObject(notFound)
    expect(await rematchUnmatchedLines(ctx, b)).toEqual({ linked: 0 })
    expect((await listOrders(ctx, b, { skip: 0, take: 50 })).items.map((order) => order.id)).toEqual([orderB])
    expect(await getOrder(ctx, b, orderA)).toBeNull()

    // Shipments
    await expect(requestShipment(ctx, b, orderA, lockerShipment(carrierB), user)).rejects.toMatchObject(notFound)
    await expect(requestShipment(ctx, b, orderB, lockerShipment(carrierA), user)).rejects.toMatchObject(notFound)
    await expect(requestShipment(ctx, a, orderA, lockerShipment(carrierB), user)).rejects.toMatchObject(notFound)
    await expect(cancelShipment(ctx, b, shipmentA, user)).rejects.toMatchObject(notFound)
    expect(await getShipmentLabel(ctx, b, shipmentA)).toBeNull()
    expect((await getShipmentLabel(ctx, a, shipmentA))?.data.byteLength).toBeGreaterThan(0)
    expect(await listOrderShipments(ctx, b, orderA)).toEqual([])
    expect((await listOrderShipments(ctx, a, orderA)).map((shipment) => shipment.id)).toEqual([shipmentA])
    expect((await listShippingConnections(ctx, b)).map((connection) => connection.id)).toEqual([carrierB])
    // A job payload with a foreign organization id is harmless: no Carrier call, no change.
    carrier.advance(atCarrier.externalId, 'in_transit')
    await shipmentsCreateJob.handler(ctx, { organizationId: b, shipmentId: shipmentA }, jobRun)
    await shipmentsTrackJob.handler(ctx, { organizationId: b, connectionId: carrierA }, jobRun)
    const delivered = { externalId: atCarrier.externalId, status: 'delivered', trackingNumber: null, carrierStatus: null } as const
    expect(await applyShipmentState(ctx, b, shipmentA, delivered, 'tracked')).toEqual({ applied: false, reason: 'not_found' })
    expect(await failShipment(ctx, b, shipmentA, 'forged')).toBe(false)
    expect(await ctx.db.shipment.count({ where: { organizationId: b } })).toBe(0)

    // Connections
    expect((await listConnections(ctx, b)).map((connection) => connection.id)).toEqual([connB, carrierB])
    expect(await getConnection(ctx, b, connA)).toBeNull()
    expect(await openConnection(ctx, b, connA)).toBeNull()
    await expect(updateChannelStockRules(ctx, b, connA, { safetyBuffer: 1, channelLimit: 1 }, user)).rejects.toMatchObject(notFound)
    await expect(updateChannelWarehouses(ctx, b, connA, { all: false, warehouseIds: [warehouseB] }, user)).rejects.toMatchObject(notFound)
    await expect(startSyncRun(ctx, b, connA, 'orders_pull')).rejects.toMatchObject(notFound)
    await expect(saveSyncCursor(ctx, b, connA, 'orders_pull', '9')).rejects.toMatchObject(notFound)
    await expect(finishSyncRun(ctx, b, connA, 'orders_pull', {})).rejects.toMatchObject(notFound)
    await expect(failSyncRun(ctx, b, connA, 'orders_pull', { kind: 'permanent', message: 'x', health: 'failing' })).rejects.toMatchObject(notFound)

    // Events
    expect(await listEvents(ctx, b, { type: 'order', id: orderA }, 50)).toEqual([])
    expect((await listEvents(ctx, a, { type: 'order', id: orderA }, 50)).length).toBeGreaterThan(0)
    expect(await listEvents(ctx, b, { type: 'warehouse', id: spareWarehouseA }, 50)).toEqual([])
    expect((await listEvents(ctx, a, { type: 'warehouse', id: spareWarehouseA }, 50)).length).toBeGreaterThan(0)

    expect(await snapshot()).toEqual(before)
  })
})
