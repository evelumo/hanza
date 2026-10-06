import { describe, expect, it } from 'vitest'
import { createProduct } from '../catalog/products'
import { updateChannelWarehouses } from '../connections/channel-warehouses'
import { DomainError } from '../errors'
import { changeOrderStatus } from '../orders/change-status'
import { importOrder } from '../orders/import'
import { moveReservation } from '../orders/move-reservation'
import { setStock } from '../stock/set-stock'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, createTestConnection, orderLine, testChannel, uniqueSku, user } from '../testing/fixtures'
import { createWarehouse, deleteWarehouse, getWarehouse, listWarehouses, setWarehouseActive, updateWarehouse } from './warehouses'

const code = (error: unknown) => (error instanceof DomainError ? error.code : error)

describe.skipIf(!databaseUrl)('Warehouses', () => {
  const context = useTestContext({ connectors: [testChannel] })

  async function setup() {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    return { ctx, org }
  }

  it('lists the default Warehouse of a new organization, and creates others after it with an Event', async () => {
    const { ctx, org } = await setup()
    const [main] = await listWarehouses(ctx, org)
    expect(main).toMatchObject({ name: 'Main warehouse', priority: 0, active: true, isDefault: true, stock: 0, reserved: 0, channels: [] })

    const { warehouseId: second } = await createWarehouse(ctx, org, { name: ' Kraków ' }, user)
    const { warehouseId: third } = await createWarehouse(ctx, org, { name: 'Gdańsk', priority: 0 }, user)
    const list = await listWarehouses(ctx, org)
    expect(list.map((warehouse) => [warehouse.name, warehouse.priority, warehouse.isDefault])).toEqual(
      expect.arrayContaining([
        ['Main warehouse', 0, true],
        ['Kraków', 1, false],
        ['Gdańsk', 0, false],
      ]),
    )
    expect(list.at(-1)?.id).toBe(second)
    expect(await getWarehouse(ctx, org, third)).toMatchObject({ name: 'Gdańsk', active: true })
    const event = await ctx.db.eventLog.findFirstOrThrow({ where: { organizationId: org, type: 'warehouse.created', subjectId: second } })
    expect(event.payload).toEqual({ name: 'Kraków', priority: 1, actor: user })
  })

  it('renames and reorders, writing an Event only when something changed', async () => {
    const { ctx, org } = await setup()
    const { warehouseId } = await createWarehouse(ctx, org, { name: 'Second' }, user)
    await updateWarehouse(ctx, org, warehouseId, { name: 'Outlet', priority: 7 }, user)
    await updateWarehouse(ctx, org, warehouseId, { name: 'Outlet', priority: 7 }, user)
    expect(await getWarehouse(ctx, org, warehouseId)).toMatchObject({ name: 'Outlet', priority: 7 })
    expect(await ctx.db.eventLog.count({ where: { organizationId: org, type: 'warehouse.updated' } })).toBe(1)
    await expect(updateWarehouse(ctx, org, warehouseId, { name: '', priority: 1 }, user)).rejects.toThrow(RangeError)
    await expect(updateWarehouse(ctx, org, warehouseId, { name: 'X', priority: -1 }, user)).rejects.toThrow(RangeError)
  })

  it('never deactivates or deletes the default Warehouse', async () => {
    const { ctx, org } = await setup()
    const [main] = await listWarehouses(ctx, org)
    await expect(setWarehouseActive(ctx, org, main!.id, false, user).catch(code)).resolves.toBe('warehouse_is_default')
    await expect(deleteWarehouse(ctx, org, main!.id, user).catch(code)).resolves.toBe('warehouse_is_default')
  })

  it('refuses to retire a Warehouse holding Stock or an open Reservation, and to delete one with Reservation history', async () => {
    const { ctx, org } = await setup()
    const connectionId = await createTestConnection(ctx, org)
    const sku = uniqueSku()
    const { productId } = await createProduct(ctx, org, { sku, name: 'Mug', stock: 0 }, user)
    const { warehouseId } = await createWarehouse(ctx, org, { name: 'Second' }, user)

    await setStock(ctx, org, productId, 2, user, warehouseId)
    await expect(setWarehouseActive(ctx, org, warehouseId, false, user).catch(code)).resolves.toBe('warehouse_not_empty')
    await expect(deleteWarehouse(ctx, org, warehouseId, user).catch(code)).resolves.toBe('warehouse_not_empty')

    // The Order lands in the second Warehouse (the default one has nothing); then Stock is set to 0 there.
    const { orderId } = await importOrder(ctx, org, connectionId, buildOrder({ lines: [orderLine('l1', { sku, quantity: 1 })] }))
    await setStock(ctx, org, productId, 0, user, warehouseId)
    await expect(setWarehouseActive(ctx, org, warehouseId, false, user).catch(code)).resolves.toBe('warehouse_not_empty')

    // Cancelled: Stock 0, no open Reservation; deactivating works, deleting does not (history).
    await changeOrderStatus(ctx, org, orderId, 'cancelled', user)
    await expect(deleteWarehouse(ctx, org, warehouseId, user).catch(code)).resolves.toBe('warehouse_in_use')
    await setWarehouseActive(ctx, org, warehouseId, false, user)
    expect(await getWarehouse(ctx, org, warehouseId)).toMatchObject({ active: false })
    await setWarehouseActive(ctx, org, warehouseId, true, user)
    expect(
      (await ctx.db.eventLog.findMany({ where: { organizationId: org, subjectId: warehouseId }, orderBy: { id: 'asc' } })).map((event) => event.type),
    ).toEqual(['warehouse.created', 'warehouse.deactivated', 'warehouse.activated'])
  })

  it('refuses to retire a Warehouse a Channel chose, and deletes an unused one with its zero Stock rows', async () => {
    const { ctx, org } = await setup()
    const connectionId = await createTestConnection(ctx, org)
    const { productId } = await createProduct(ctx, org, { sku: uniqueSku(), name: 'Mug', stock: 1 }, user)
    const { warehouseId } = await createWarehouse(ctx, org, { name: 'Second' }, user)
    await updateChannelWarehouses(ctx, org, connectionId, { all: false, warehouseIds: [warehouseId] }, user)

    await expect(setWarehouseActive(ctx, org, warehouseId, false, user).catch(code)).resolves.toBe('warehouse_in_use')
    await expect(deleteWarehouse(ctx, org, warehouseId, user).catch(code)).resolves.toBe('warehouse_in_use')
    expect((await getWarehouse(ctx, org, warehouseId))?.channels.map((channel) => channel.id)).toEqual([connectionId])

    await updateChannelWarehouses(ctx, org, connectionId, { all: true }, user)
    // A Stock row of 0 does not count as holding Stock.
    await setStock(ctx, org, productId, 0, user, warehouseId)
    await deleteWarehouse(ctx, org, warehouseId, user)
    expect(await getWarehouse(ctx, org, warehouseId)).toBeNull()
    expect(await ctx.db.stock.count({ where: { organizationId: org, warehouseId } })).toBe(0)
    expect(await ctx.db.eventLog.count({ where: { organizationId: org, type: 'warehouse.deleted', subjectId: warehouseId } })).toBe(1)
  })

  it('an inactive Warehouse takes no Stock, no moved Reservation and no Channel choice', async () => {
    const { ctx, org } = await setup()
    const connectionId = await createTestConnection(ctx, org)
    const sku = uniqueSku()
    const { productId } = await createProduct(ctx, org, { sku, name: 'Mug', stock: 5 }, user)
    const { warehouseId } = await createWarehouse(ctx, org, { name: 'Closed' }, user)
    await setWarehouseActive(ctx, org, warehouseId, false, user)
    const { orderId } = await importOrder(ctx, org, connectionId, buildOrder({ lines: [orderLine('l1', { sku, quantity: 1 })] }))
    const line = await ctx.db.orderLine.findFirstOrThrow({ where: { orderId } })

    await expect(setStock(ctx, org, productId, 3, user, warehouseId).catch(code)).resolves.toBe('warehouse_inactive')
    await expect(moveReservation(ctx, org, line.id, warehouseId, user).catch(code)).resolves.toBe('warehouse_inactive')
    await expect(
      updateChannelWarehouses(ctx, org, connectionId, { all: false, warehouseIds: [warehouseId] }, user).catch(code),
    ).resolves.toBe('warehouse_inactive')
  })

  it('never reaches another organization\'s Warehouse', async () => {
    const { ctx, org } = await setup()
    const other = await createTestOrganization(ctx.db)
    const { warehouseId } = await createWarehouse(ctx, other, { name: 'Theirs' }, user)
    const { productId } = await createProduct(ctx, org, { sku: uniqueSku(), name: 'Mug', stock: 1 }, user)
    const connectionId = await createTestConnection(ctx, org)

    expect(await getWarehouse(ctx, org, warehouseId)).toBeNull()
    for (const attempt of [
      () => updateWarehouse(ctx, org, warehouseId, { name: 'Mine', priority: 1 }, user),
      () => setWarehouseActive(ctx, org, warehouseId, false, user),
      () => deleteWarehouse(ctx, org, warehouseId, user),
      () => setStock(ctx, org, productId, 3, user, warehouseId),
      () => updateChannelWarehouses(ctx, org, connectionId, { all: false, warehouseIds: [warehouseId] }, user),
    ]) {
      await expect(attempt().catch(code)).resolves.toBe('not_found')
    }
    expect(await getWarehouse(ctx, other, warehouseId)).toMatchObject({ name: 'Theirs', active: true })
  })
})
