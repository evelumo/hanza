import { describe, expect, it } from 'vitest'
import { upsertOffers } from '../catalog/offers'
import { createProduct } from '../catalog/products'
import { changeOrderStatus } from '../orders/change-status'
import { importOrder } from '../orders/import'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, createTestConnection, orderLine, user } from '../testing/fixtures'
import { getAvailability } from './availability'
import { setStock } from './set-stock'
import { ensureDefaultWarehouse } from './warehouse'

describe.skipIf(!databaseUrl)('stock', () => {
  const context = useTestContext()

  it('creates the default Warehouse once', async () => {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const ids = await Promise.all([ensureDefaultWarehouse(ctx.db, org), ensureDefaultWarehouse(ctx.db, org)])
    expect(ids[0]).toBe(ids[1])
    expect(await ctx.db.warehouse.findMany({ where: { organizationId: org } })).toMatchObject([{ code: 'default', name: 'Magazyn główny' }])
  })

  it('setStock writes stock.set with from/to, bumps linked Offers and requests a push', async () => {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const connectionId = await createTestConnection(ctx, org)
    const { productId } = await createProduct(ctx, org, { sku: 'S', name: 'S', stock: 2 }, user)
    await upsertOffers(ctx, org, connectionId, [{ externalId: 'o', sku: 'S', name: 'O', url: null }], new Date())
    ctx.queue.waiting.length = 0

    await setStock(ctx, org, productId, 5, user)

    const warehouseId = await ensureDefaultWarehouse(ctx.db, org)
    const event = await ctx.db.eventLog.findFirstOrThrow({ where: { organizationId: org, type: 'stock.set' } })
    expect(event).toMatchObject({ subjectType: 'product', subjectId: productId, payload: { warehouseId, from: 2, to: 5, actor: user } })
    expect(await ctx.db.offer.findFirstOrThrow({ where: { organizationId: org } })).toMatchObject({ stockPushSeq: 2 })
    expect(ctx.queue.waiting.map((job) => job.payload)).toEqual([{ organizationId: org, connectionId }])
    expect((await getAvailability(ctx.db, org, [productId])).get(productId)).toEqual({ stock: 5, reserved: 0, available: 5 })

    await expect(setStock(ctx, org, productId, -1, user)).rejects.toThrow(RangeError)
    await expect(setStock(ctx, org, productId, 1.5, user)).rejects.toThrow(RangeError)
  })

  it('getAvailability counts only open Reservations and sums every Warehouse', async () => {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const connectionId = await createTestConnection(ctx, org)
    const { productId } = await createProduct(ctx, org, { sku: 'AV', name: 'AV', stock: 10 }, user)
    const line = (quantity: number) => [orderLine('l1', { sku: 'AV', quantity })]

    await importOrder(ctx, org, connectionId, buildOrder({ lines: line(2) }))
    const released = await importOrder(ctx, org, connectionId, buildOrder({ lines: line(3) }))
    await changeOrderStatus(ctx, org, released.orderId, 'cancelled', user)
    const consumed = await importOrder(ctx, org, connectionId, buildOrder({ lines: line(1) }))
    await changeOrderStatus(ctx, org, consumed.orderId, 'shipped', user)

    expect((await getAvailability(ctx.db, org, [productId])).get(productId)).toEqual({ stock: 9, reserved: 2, available: 7 })

    const second = await ctx.db.warehouse.create({ data: { organizationId: org, code: 'second', name: 'Second' } })
    await ctx.db.stock.create({ data: { organizationId: org, productId, warehouseId: second.id, units: 4 } })
    const availability = await getAvailability(ctx.db, org, [productId, 'missing'])
    expect(availability.get(productId)).toEqual({ stock: 13, reserved: 2, available: 11 })
    expect(availability.get('missing')).toEqual({ stock: 0, reserved: 0, available: 0 })
  })
})
