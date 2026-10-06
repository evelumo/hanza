import { describe, expect, it } from 'vitest'
import { upsertOffers } from '../catalog/offers'
import { createProduct, getProduct } from '../catalog/products'
import { getConnection } from '../connections/connections'
import { updateChannelStockRules } from '../connections/stock-rules'
import { updateChannelWarehouses } from '../connections/channel-warehouses'
import { systemActor } from '../actor'
import { DomainError } from '../errors'
import { changeOrderStatus } from '../orders/change-status'
import { importOrder } from '../orders/import'
import { linkOrderLine } from '../orders/link-line'
import { moveReservation } from '../orders/move-reservation'
import { getOrder } from '../orders/queries'
import { eraseBuyerData } from '../privacy/erasure'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, createTestConnection, orderLine, testChannel, testCourier, uniqueSku, user } from '../testing/fixtures'
import { createConnection } from '../connections/connections'
import { createWarehouse, deleteWarehouse, listWarehouses, setWarehouseActive, updateWarehouse } from '../warehouses/warehouses'
import { getAvailability, getWarehouseAvailability } from './availability'
import { getChannelAvailability } from './channel-available'
import { setStock } from './set-stock'

const code = (error: unknown) => (error instanceof DomainError ? error.code : error)

// Two Warehouses (main = the default, priority 0; north, priority 1) and two Channels:
// "all" counts both, "north" counts only the north Warehouse.
describe.skipIf(!databaseUrl)('multiple Warehouses', () => {
  const context = useTestContext({ connectors: [testChannel, testCourier] })

  async function setup(stock: { main: number; north: number }) {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const all = await createTestConnection(ctx, org, 'All')
    const northOnly = await createTestConnection(ctx, org, 'North only')
    const sku = uniqueSku()
    const { productId } = await createProduct(ctx, org, { sku, name: 'Mug', stock: stock.main }, user)
    const main = (await listWarehouses(ctx, org))[0]!.id
    const { warehouseId: north } = await createWarehouse(ctx, org, { name: 'North' }, user)
    await setStock(ctx, org, productId, stock.north, user, north)
    await updateChannelWarehouses(ctx, org, northOnly, { all: false, warehouseIds: [north] }, user)
    for (const connectionId of [all, northOnly]) {
      await upsertOffers(ctx, org, connectionId, [{ externalId: 'offer', sku, name: 'Mug', url: null }], new Date())
    }
    ctx.queue.waiting.length = 0
    const order = (connectionId: string, quantity: number) =>
      importOrder(ctx, org, connectionId, buildOrder({ lines: [orderLine('l1', { sku, quantity })] }))
    const reservationOf = async (orderId: string) => {
      const line = await ctx.db.orderLine.findFirstOrThrow({ where: { orderId }, include: { reservation: true } })
      return { lineId: line.id, shortage: line.shortage, warehouseId: line.reservation?.warehouseId, status: line.reservation?.status }
    }
    const perWarehouse = async () => {
      const map = await getWarehouseAvailability(ctx.db, org, productId, [main, north])
      return { main: map.get(main)!.available, north: map.get(north)!.available }
    }
    const told = async () => ({
      all: (await getChannelAvailability(ctx.db, org, all, [productId])).get(productId),
      northOnly: (await getChannelAvailability(ctx.db, org, northOnly, [productId])).get(productId),
    })
    return { ctx, org, all, northOnly, sku, productId, main, north, order, reservationOf, perWarehouse, told }
  }

  it('sets Stock per Warehouse; the Product shows each, and the organization total is their sum', async () => {
    const { ctx, org, productId, main, north } = await setup({ main: 4, north: 6 })
    const product = await getProduct(ctx, org, productId)
    expect(product?.warehouses.map((warehouse) => [warehouse.id, warehouse.isDefault, warehouse.stock, warehouse.available])).toEqual([
      [main, true, 4, 4],
      [north, false, 6, 6],
    ])
    expect(product).toMatchObject({ stock: 10, reserved: 0, available: 10 })
    const event = await ctx.db.eventLog.findFirstOrThrow({ where: { organizationId: org, type: 'stock.set' } })
    expect(event.payload).toMatchObject({ warehouseId: north, from: 0, to: 6 })
  })

  it('tells each Channel what one of its own Warehouses can cover, with its buffer and limit on top', async () => {
    const { ctx, org, northOnly, told } = await setup({ main: 4, north: 6 })
    // "All" holds 4 + 6, but a line is never split: the most one line can get without a Shortage is 6.
    expect(await told()).toEqual({ all: 6, northOnly: 6 })
    await updateChannelStockRules(ctx, org, northOnly, { safetyBuffer: 1, channelLimit: 4 }, user)
    expect(await told()).toEqual({ all: 6, northOnly: 4 })
    await updateChannelStockRules(ctx, org, northOnly, { safetyBuffer: 3, channelLimit: null }, user)
    expect(await told()).toEqual({ all: 6, northOnly: 3 })
  })

  it('the reviewed overselling case is impossible: no Channel is told a number one Warehouse cannot cover', async () => {
    const { ctx, org, all, northOnly, main, north, productId, order, reservationOf, perWarehouse, told } = await setup({ main: 3, north: 2 })
    // Was 5 for "all" (3 + 2): a line of 5 then became a Shortage while north-only kept selling north's 2.
    expect(await told()).toEqual({ all: 3, northOnly: 2 })

    // Each Channel sells exactly what it was told: every line is covered, nothing is oversold.
    const fromAll = await order(all, 3)
    expect(await reservationOf(fromAll.orderId)).toMatchObject({ warehouseId: main, shortage: false })
    expect(await told()).toEqual({ all: 2, northOnly: 2 })
    const fromNorth = await order(northOnly, 2)
    expect(await reservationOf(fromNorth.orderId)).toMatchObject({ warehouseId: north, shortage: false })
    expect(await told()).toEqual({ all: 0, northOnly: 0 })
    expect(await perWarehouse()).toEqual({ main: 0, north: 0 })
    expect((await getAvailability(ctx.db, org, [productId])).get(productId)).toEqual({ stock: 5, reserved: 5, available: 0 })
    expect(await ctx.db.orderLine.count({ where: { organizationId: org, shortage: true } })).toBe(0)
  })

  it('a Shortage that still happens (a stale number) goes where it owes least, and lowers every Channel counting that Warehouse', async () => {
    const { all, main, order, reservationOf, perWarehouse, told } = await setup({ main: 3, north: 2 })
    // A line of 4 although "all" is told 3 (say a push had not arrived yet): no Warehouse covers it.
    const { orderId } = await order(all, 4)
    expect(await reservationOf(orderId)).toMatchObject({ warehouseId: main, shortage: true })
    expect(await perWarehouse()).toEqual({ main: -1, north: 2 })
    // The owed unit counts against "all" (−1 + 2); north's 2 units are really there, so north-only keeps them.
    expect(await told()).toEqual({ all: 1, northOnly: 2 })
  })

  it('a Shortage goes to the Warehouse with the most Available, not to the first, when none covers the line', async () => {
    const { all, north, order, reservationOf, perWarehouse, told } = await setup({ main: 1, north: 3 })
    const { orderId } = await order(all, 4)
    expect(await reservationOf(orderId)).toMatchObject({ warehouseId: north, shortage: true })
    expect(await perWarehouse()).toEqual({ main: 1, north: -1 })
    expect(await told()).toEqual({ all: 0, northOnly: 0 })
  })

  it('a multi-line Order: each line is placed on its own, re-reading Available, and none is short when each fits', async () => {
    const { ctx, org, all, main, north, sku, perWarehouse, told } = await setup({ main: 3, north: 3 })
    expect(await told()).toEqual({ all: 3, northOnly: 3 })
    const { orderId } = await importOrder(
      ctx,
      org,
      all,
      buildOrder({ lines: [orderLine('l1', { sku, quantity: 2 }), orderLine('l2', { sku, quantity: 2 })] }),
    )
    const lines = await ctx.db.orderLine.findMany({ where: { orderId }, orderBy: { externalId: 'asc' }, include: { reservation: true } })
    expect(lines.map((line) => [line.reservation?.warehouseId, line.shortage])).toEqual([
      [main, false],
      [north, false],
    ])
    expect(await perWarehouse()).toEqual({ main: 1, north: 1 })
    expect(await told()).toEqual({ all: 1, northOnly: 1 })
  })

  it('reserves in the first Warehouse, by priority, that covers the whole line', async () => {
    const { all, main, north, order, reservationOf, perWarehouse, told } = await setup({ main: 2, north: 5 })

    // Main (priority 0) covers 2.
    const first = await order(all, 2)
    expect(await reservationOf(first.orderId)).toMatchObject({ warehouseId: main, shortage: false, status: 'open' })
    // Main has 0 left; north covers 3.
    const second = await order(all, 3)
    expect(await reservationOf(second.orderId)).toMatchObject({ warehouseId: north, shortage: false })
    expect(await perWarehouse()).toEqual({ main: 0, north: 2 })
    expect(await told()).toEqual({ all: 2, northOnly: 2 })
  })

  it('a lower priority number moves a Warehouse ahead', async () => {
    const { ctx, org, all, main, north, order, reservationOf } = await setup({ main: 5, north: 5 })
    await updateWarehouse(ctx, org, main, { name: 'Main warehouse', priority: 9 }, user)
    const { orderId } = await order(all, 1)
    expect(await reservationOf(orderId)).toMatchObject({ warehouseId: north, shortage: false })
  })

  it('judges an Order only against its Channel\'s Warehouses: a Shortage even though another Warehouse could cover it', async () => {
    const { ctx, northOnly, north, order, reservationOf, perWarehouse, told } = await setup({ main: 10, north: 1 })
    const { orderId } = await order(northOnly, 3)
    expect(await reservationOf(orderId)).toMatchObject({ warehouseId: north, shortage: true })
    expect((await ctx.db.order.findFirstOrThrow({ where: { id: orderId } })).attentionReasons).toEqual(['shortage'])
    expect(await perWarehouse()).toEqual({ main: 10, north: -2 })
    // The negative Warehouse is owed units: the "all" Channel is told min(10 − 2, 10), never more.
    expect(await told()).toEqual({ all: 8, northOnly: 0 })
  })

  it('never splits a line: 3 + 3 does not cover 5, so it is a Shortage (a tie goes to the first Warehouse)', async () => {
    const { all, main, order, reservationOf, perWarehouse, told } = await setup({ main: 3, north: 3 })
    // "all" is told 3, so a line of 5 only comes from a stale number.
    expect(await told()).toEqual({ all: 3, northOnly: 3 })
    const { orderId } = await order(all, 5)
    expect(await reservationOf(orderId)).toMatchObject({ warehouseId: main, shortage: true })
    expect(await perWarehouse()).toEqual({ main: -2, north: 3 })
    expect(await told()).toEqual({ all: 1, northOnly: 3 })
  })

  it('ships and cancels from the Reservation\'s own Warehouse', async () => {
    const { ctx, org, all, main, north, productId, order, perWarehouse } = await setup({ main: 1, north: 5 })
    const toNorth = await order(all, 2)
    const toMain = await order(all, 1)
    expect(await perWarehouse()).toEqual({ main: 0, north: 3 })

    await changeOrderStatus(ctx, org, toNorth.orderId, 'shipped', user)
    const stock = async () =>
      Object.fromEntries(
        (await ctx.db.stock.findMany({ where: { organizationId: org, productId } })).map((row) => [row.warehouseId === main ? 'main' : row.warehouseId === north ? 'north' : row.warehouseId, row.units]),
      )
    expect(await stock()).toEqual({ main: 1, north: 3 })
    await changeOrderStatus(ctx, org, toMain.orderId, 'cancelled', user)
    expect(await stock()).toEqual({ main: 1, north: 3 })
    expect(await perWarehouse()).toEqual({ main: 1, north: 3 })
    const consumed = await ctx.db.eventLog.findFirstOrThrow({ where: { organizationId: org, type: 'stock.consumed' } })
    expect(consumed.payload).toMatchObject({ warehouseId: north, units: 2 })
    const released = await ctx.db.eventLog.findFirstOrThrow({ where: { organizationId: org, type: 'stock.released' } })
    expect(released.payload).toMatchObject({ warehouseId: main, units: 1 })
  })

  it('linking an Unmatched line places it by the same rule for its Order\'s Channel', async () => {
    const { ctx, org, northOnly, north, productId, reservationOf } = await setup({ main: 10, north: 0 })
    const { orderId } = await importOrder(ctx, org, northOnly, buildOrder({ lines: [orderLine('l1', { sku: 'NOPE', quantity: 1 })] }))
    const line = await ctx.db.orderLine.findFirstOrThrow({ where: { orderId } })
    await linkOrderLine(ctx, org, line.id, productId, user)
    expect(await reservationOf(orderId)).toMatchObject({ warehouseId: north, shortage: true })
  })

  it('moves a Reservation to a Warehouse that covers it: clears the Shortage, records it, and pushes every Channel', async () => {
    const { ctx, org, northOnly, all, main, north, order, reservationOf, perWarehouse, told } = await setup({ main: 10, north: 1 })
    const { orderId } = await order(northOnly, 3)
    const { lineId } = await reservationOf(orderId)
    ctx.queue.waiting.length = 0

    await moveReservation(ctx, org, lineId, main, user)

    expect(await reservationOf(orderId)).toMatchObject({ warehouseId: main, shortage: false, status: 'open' })
    expect(await perWarehouse()).toEqual({ main: 7, north: 1 })
    expect(await told()).toEqual({ all: 7, northOnly: 1 })
    expect((await ctx.db.order.findFirstOrThrow({ where: { id: orderId } })).attentionReasons).toEqual([])
    const moved = await ctx.db.eventLog.findFirstOrThrow({ where: { organizationId: org, type: 'order.reservation_moved' } })
    expect(moved).toMatchObject({ subjectType: 'order', subjectId: orderId })
    expect(moved.payload).toMatchObject({ orderLineId: lineId, fromWarehouseId: north, toWarehouseId: main, units: 3, actor: user })
    expect(await ctx.db.eventLog.count({ where: { organizationId: org, type: 'order.attention_resolved' } })).toBe(1)
    expect(ctx.queue.waiting.map((job) => (job.payload as { connectionId: string }).connectionId).sort()).toEqual([all, northOnly].sort())
    const detail = await getOrder(ctx, org, orderId)
    expect(detail?.lines[0]?.reservationWarehouse).toEqual({ id: main, name: 'Main warehouse' })
  })

  it('refuses a move the target cannot cover, of a closed Reservation, or to an unknown Warehouse; the same Warehouse is a no-op', async () => {
    const { ctx, org, all, main, north, order, reservationOf } = await setup({ main: 2, north: 1 })
    const { orderId } = await order(all, 2)
    const { lineId } = await reservationOf(orderId)
    await expect(moveReservation(ctx, org, lineId, north, user).catch(code)).resolves.toBe('not_enough_stock')
    await expect(moveReservation(ctx, org, lineId, 'no-such-warehouse', user).catch(code)).resolves.toBe('not_found')
    await moveReservation(ctx, org, lineId, main, user)
    expect(await ctx.db.eventLog.count({ where: { organizationId: org, type: 'order.reservation_moved' } })).toBe(0)

    await changeOrderStatus(ctx, org, orderId, 'shipped', user)
    await setStock(ctx, org, (await ctx.db.orderLine.findFirstOrThrow({ where: { id: lineId } })).productId!, 9, user, north)
    await expect(moveReservation(ctx, org, lineId, north, user).catch(code)).resolves.toBe('reservation_not_open')
  })

  it('an Order awaiting payment is placed by the same rule and its Reservation can move; erasing its Buyer data leaves Stock alone', async () => {
    const { ctx, org, northOnly, main, north, sku, reservationOf, perWarehouse } = await setup({ main: 5, north: 3 })
    const email = `${uniqueSku('buyer').toLowerCase()}@example.com`
    const buyer = { name: 'Anna Test', email, phone: null, login: null }
    const { orderId } = await importOrder(
      ctx,
      org,
      northOnly,
      buildOrder({ awaitingPayment: true, buyer, lines: [orderLine('l1', { sku, quantity: 2 })] }),
    )
    expect((await ctx.db.order.findFirstOrThrow({ where: { id: orderId } })).awaitingPayment).toBe(true)
    expect(await reservationOf(orderId)).toMatchObject({ warehouseId: north, shortage: false, status: 'open' })

    const { lineId } = await reservationOf(orderId)
    await moveReservation(ctx, org, lineId, main, user)
    expect(await reservationOf(orderId)).toMatchObject({ warehouseId: main, status: 'open' })
    expect(await perWarehouse()).toEqual({ main: 3, north: 3 })

    await changeOrderStatus(ctx, org, orderId, 'cancelled', user)
    expect(await perWarehouse()).toEqual({ main: 5, north: 3 })
    const stockState = async () => ({
      reservations: await ctx.db.reservation.findMany({ where: { organizationId: org }, orderBy: { id: 'asc' } }),
      stock: await ctx.db.stock.findMany({ where: { organizationId: org }, orderBy: { id: 'asc' } }),
      warehouses: await ctx.db.warehouse.findMany({ where: { organizationId: org }, orderBy: { id: 'asc' } }),
    })
    const before = await stockState()
    expect(await eraseBuyerData(ctx, org, email, systemActor)).toEqual({ erased: 1, keptOpen: 0 })
    expect(await stockState()).toEqual(before)
  })

  it('a Channel\'s Warehouse choice: stored, validated, bumps only its Offers, and needs a Channel', async () => {
    const { ctx, org, all, northOnly, main, north, told } = await setup({ main: 4, north: 6 })
    expect((await getConnection(ctx, org, all))?.warehouses).toEqual({ all: true, warehouseIds: [] })
    expect((await getConnection(ctx, org, northOnly))?.warehouses).toEqual({ all: false, warehouseIds: [north] })
    const seq = async (connectionId: string) => (await ctx.db.offer.findFirstOrThrow({ where: { connectionId } })).stockPushSeq
    const before = { all: await seq(all), northOnly: await seq(northOnly) }

    await updateChannelWarehouses(ctx, org, northOnly, { all: false, warehouseIds: [main, north, main] }, user)
    expect((await getConnection(ctx, org, northOnly))?.warehouses).toEqual({ all: false, warehouseIds: [main, north].sort() })
    expect(await told()).toEqual({ all: 6, northOnly: 6 })
    expect(await seq(northOnly)).toBe(before.northOnly + 1)
    expect(await seq(all)).toBe(before.all)
    expect(ctx.queue.waiting.map((job) => job.payload)).toEqual([{ organizationId: org, connectionId: northOnly }])

    // Unchanged: no Event, no bump.
    await updateChannelWarehouses(ctx, org, northOnly, { all: false, warehouseIds: [north, main] }, user)
    expect(await seq(northOnly)).toBe(before.northOnly + 1)
    expect(await ctx.db.eventLog.count({ where: { organizationId: org, type: 'connection.warehouses_changed' } })).toBe(2)

    await expect(updateChannelWarehouses(ctx, org, northOnly, { all: false, warehouseIds: [] }, user).catch(code)).resolves.toBe(
      'no_warehouse_selected',
    )
    const { connectionId: courier } = await createConnection(
      ctx,
      org,
      { connectorId: 'test-courier', name: 'Courier', config: {}, credentials: {} },
      user,
    )
    await expect(updateChannelWarehouses(ctx, org, courier, { all: true }, user).catch(code)).resolves.toBe('not_a_channel')
  })

  it('a Warehouse added later counts at once for a Channel that counts all, and for no Channel that chose', async () => {
    const { ctx, org, all, productId, order, told } = await setup({ main: 1, north: 2 })
    // Earlier transactions locked the Warehouses that existed then; a new transaction sees the new one.
    await order(all, 1)
    const { warehouseId: south } = await createWarehouse(ctx, org, { name: 'South' }, user)
    await setStock(ctx, org, productId, 7, user, south)
    // Main 0, north 2, south 7: one line can get at most 7.
    expect(await told()).toEqual({ all: 7, northOnly: 2 })
    expect((await getAvailability(ctx.db, org, [productId])).get(productId)?.available).toBe(9)
  })

  it('creating, (de)activating, reordering, renaming or deleting a Warehouse never changes what a Channel is told, so needs no push', async () => {
    const { ctx, org, all, main, north, productId, order, told } = await setup({ main: 3, north: 2 })
    // An oversold main (−1) next to north (2), so both parts of the formula matter.
    await order(all, 4)
    const both = await createTestConnection(ctx, org, 'Both')
    await updateChannelWarehouses(ctx, org, both, { all: false, warehouseIds: [main, north] }, user)
    const snapshot = async () => ({
      ...(await told()),
      both: (await getChannelAvailability(ctx.db, org, both, [productId])).get(productId),
      seqs: (await ctx.db.offer.findMany({ where: { organizationId: org }, orderBy: { id: 'asc' } })).map((offer) => offer.stockPushSeq),
    })
    const before = await snapshot()
    expect(before).toMatchObject({ all: 1, northOnly: 2, both: 1 })

    const { warehouseId: spare } = await createWarehouse(ctx, org, { name: 'Spare', priority: 0 }, user)
    expect(await snapshot()).toEqual(before)
    await updateWarehouse(ctx, org, north, { name: 'North 2', priority: 0 }, user)
    await updateWarehouse(ctx, org, main, { name: 'Main', priority: 50 }, user)
    expect(await snapshot()).toEqual(before)
    await setWarehouseActive(ctx, org, spare, false, user)
    expect(await snapshot()).toEqual(before)
    await setWarehouseActive(ctx, org, spare, true, user)
    expect(await snapshot()).toEqual(before)
    await setWarehouseActive(ctx, org, spare, false, user)
    await deleteWarehouse(ctx, org, spare, user)
    expect(await snapshot()).toEqual(before)
  })

  it('property: on random layouts every Channel is told min(sum, largest) of its Warehouses, and a line of that size is never short', async () => {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const main = (await listWarehouses(ctx, org))[0]!.id
    const north = (await createWarehouse(ctx, org, { name: 'North' }, user)).warehouseId
    const south = (await createWarehouse(ctx, org, { name: 'South' }, user)).warehouseId
    const channels = {
      all: await createTestConnection(ctx, org, 'All'),
      northOnly: await createTestConnection(ctx, org, 'North only'),
      northSouth: await createTestConnection(ctx, org, 'North and south'),
    }
    await updateChannelWarehouses(ctx, org, channels.northOnly, { all: false, warehouseIds: [north] }, user)
    await updateChannelWarehouses(ctx, org, channels.northSouth, { all: false, warehouseIds: [north, south] }, user)
    const sets: Record<string, string[]> = {
      [channels.all]: [main, north, south],
      [channels.northOnly]: [north],
      [channels.northSouth]: [north, south],
    }
    const connectionIds = Object.values(channels)
    let state = 7
    const next = (min: number, max: number) => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
      return min + (state % (max - min + 1))
    }

    for (let product = 0; product < 8; product++) {
      const sku = uniqueSku(`PROP${product}`)
      const { productId } = await createProduct(ctx, org, { sku, name: sku, stock: next(0, 6) }, user)
      await setStock(ctx, org, productId, next(0, 6), user, north)
      await setStock(ctx, org, productId, next(0, 6), user, south)
      // Random earlier Orders, some beyond what the Channel was told (stale numbers), so some Warehouses go negative.
      for (let i = next(0, 4); i > 0; i--) {
        const connectionId = connectionIds[next(0, 2)]!
        await importOrder(ctx, org, connectionId, buildOrder({ lines: [orderLine('l1', { sku, quantity: next(1, 5) })] }))
      }

      for (const connectionId of connectionIds) {
        const told = (await getChannelAvailability(ctx.db, org, connectionId, [productId])).get(productId)!
        const values = [...(await getWarehouseAvailability(ctx.db, org, productId, sets[connectionId]!)).values()].map((value) => value.available)
        expect(told).toBe(Math.max(0, Math.min(values.reduce((a, b) => a + b, 0), Math.max(...values))))
        expect(told).toBeLessThanOrEqual(Math.max(0, ...values))
        if (told === 0) continue
        // The Channel sells exactly what it was told, in one line: one of its Warehouses covers it.
        const { orderId } = await importOrder(ctx, org, connectionId, buildOrder({ lines: [orderLine('l1', { sku, quantity: told })] }))
        const line = await ctx.db.orderLine.findFirstOrThrow({ where: { orderId }, include: { reservation: true } })
        expect(line.shortage).toBe(false)
        expect(sets[connectionId]).toContain(line.reservation?.warehouseId)
      }
    }
  })
})
