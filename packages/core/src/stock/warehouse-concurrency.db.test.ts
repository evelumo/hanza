import { describe, expect, it } from 'vitest'
import { upsertOffers } from '../catalog/offers'
import { createProduct } from '../catalog/products'
import { updateChannelWarehouses } from '../connections/channel-warehouses'
import { updateChannelStockRules } from '../connections/stock-rules'
import { DomainError } from '../errors'
import { stockPushJob } from '../jobs/stock-push'
import { importOrder } from '../orders/import'
import { moveReservation } from '../orders/move-reservation'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, createTestConnection, fact, orderLine, testChannel, user } from '../testing/fixtures'
import { uniqueApplicationName, watchLockWaits } from '../testing/lock-waits'
import { createWarehouse, listWarehouses, setWarehouseActive, updateWarehouse } from '../warehouses/warehouses'
import { getAvailability, getWarehouseAvailability } from './availability'
import { channelAvailable, channelWarehousesAvailable } from './channel-available'
import { setStock } from './set-stock'
import { channelWarehouseIds } from './warehouse'

// Real parallel transactions against Postgres, as in `stock-concurrency.db.test.ts`, with several
// Warehouses: Warehouse rows join the lock order (ADR 0017) and must not deadlock with anything.

const applicationName = uniqueApplicationName('hanza-warehouse-concurrency')

describe.skipIf(!databaseUrl)('multiple Warehouses under concurrency', () => {
  const context = useTestContext({ applicationName, connectors: [testChannel] })

  it('(1) parallel imports of one Product from Channels with different Warehouses: no Warehouse is promised more than it holds', async () => {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const { productId } = await createProduct(ctx, org, { sku: 'HOT', name: 'Hot', stock: 5 }, user)
    const main = (await listWarehouses(ctx, org))[0]!.id
    const { warehouseId: north } = await createWarehouse(ctx, org, { name: 'North' }, user)
    await setStock(ctx, org, productId, 5, user, north)
    const channels = {
      mainOnly: await createTestConnection(ctx, org, 'Main only'),
      northOnly: await createTestConnection(ctx, org, 'North only'),
      both: await createTestConnection(ctx, org, 'Both'),
    }
    await updateChannelWarehouses(ctx, org, channels.mainOnly, { all: false, warehouseIds: [main] }, user)
    await updateChannelWarehouses(ctx, org, channels.northOnly, { all: false, warehouseIds: [north] }, user)
    const allowed: Record<string, string[]> = { [channels.mainOnly]: [main], [channels.northOnly]: [north], [channels.both]: [main, north] }
    const order = () => buildOrder({ lines: [orderLine('l1', { sku: 'HOT', quantity: 1 })] })
    const watcher = watchLockWaits(databaseUrl!, applicationName)

    const jobs = [
      ...Array.from({ length: 7 }, () => importOrder(ctx, org, channels.mainOnly, order())),
      ...Array.from({ length: 7 }, () => importOrder(ctx, org, channels.northOnly, order())),
      ...Array.from({ length: 4 }, () => importOrder(ctx, org, channels.both, order())),
    ]
    await Promise.all(jobs)

    expect(await watcher.stop()).toBeGreaterThan(0)
    const lines = await ctx.db.orderLine.findMany({ where: { organizationId: org }, include: { reservation: true, order: true } })
    expect(lines).toHaveLength(18)
    const covered = (warehouseId: string) => lines.filter((line) => line.reservation?.warehouseId === warehouseId && !line.shortage).length
    for (const line of lines) {
      // Every Reservation sits in exactly one Warehouse, and one its Channel counts.
      expect(allowed[line.order.connectionId]).toContain(line.reservation?.warehouseId)
      // A Shortage only when every Warehouse of the line's Channel was already fully promised.
      if (line.shortage) for (const warehouseId of allowed[line.order.connectionId]!) expect(covered(warehouseId)).toBe(5)
    }
    // No Warehouse covers more lines than it holds, and 10 units means exactly 10 covered lines.
    expect(covered(main)).toBe(5)
    expect(covered(north)).toBe(5)
    expect(lines.filter((line) => line.shortage)).toHaveLength(8)
    expect((await getAvailability(ctx.db, org, [productId])).get(productId)).toEqual({ stock: 10, reserved: 18, available: -8 })
  })

  it('(2) mixed load with Warehouses, Channel choices, moves and Warehouse edits: no deadlock, every Offer ends at its Channel Available', async () => {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const skus = ['WMIX-1', 'WMIX-2', 'WMIX-3']
    const productIds: string[] = []
    for (const sku of skus) productIds.push((await createProduct(ctx, org, { sku, name: sku, stock: 40 }, user)).productId)
    const main = (await listWarehouses(ctx, org))[0]!.id
    const { warehouseId: north } = await createWarehouse(ctx, org, { name: 'North' }, user)
    // Last in priority and never stocked: deactivating it is always allowed, so it only adds lock traffic.
    const { warehouseId: spare } = await createWarehouse(ctx, org, { name: 'Spare', priority: 1000 }, user)
    for (const productId of productIds) await setStock(ctx, org, productId, 40, user, north)
    const connections = [
      await createTestConnection(ctx, org, 'A'),
      await createTestConnection(ctx, org, 'B'),
      await createTestConnection(ctx, org, 'C'),
    ]
    await updateChannelWarehouses(ctx, org, connections[1]!, { all: false, warehouseIds: [north] }, user)
    const offers = (reverse: boolean) =>
      (reverse ? [...skus].reverse() : skus).map((sku) => ({ externalId: `offer-${sku}`, sku, name: sku, url: null }))
    for (const connectionId of connections) await upsertOffers(ctx, org, connectionId, offers(false), new Date())
    const reversedLines = () => [...skus].reverse().map((sku, i) => orderLine(`l${i}`, { sku, quantity: 1 + (i % 2) }))
    const expected = (error: unknown) =>
      error instanceof DomainError && ['not_enough_stock', 'reservation_not_open'].includes(error.code)
    const choices = [{ all: true } as const, { all: false, warehouseIds: [main] }, { all: false, warehouseIds: [north, main] }]
    const watcher = watchLockWaits(databaseUrl!, applicationName)

    const outcome = { moved: 0, refused: 0 }
    for (let round = 0; round < 6; round++) {
      // Stock is ample, so these moves succeed unless their Order is cancelled in the same round.
      const lines = await ctx.db.orderLine.findMany({
        where: { organizationId: org, reservation: { status: 'open' } },
        include: { reservation: true },
        orderBy: { id: 'desc' },
        take: 6,
      })
      const moves = lines.map((line) =>
        moveReservation(ctx, org, line.id, line.reservation!.warehouseId === main ? north : main, user).then(
          () => void outcome.moved++,
          (error: unknown) => {
            if (!expected(error)) throw error
            outcome.refused++
          },
        ),
      )
      await Promise.all([
        ...moves,
        updateChannelWarehouses(ctx, org, connections[0]!, choices[round % 3]!, user),
        updateChannelWarehouses(ctx, org, connections[2]!, choices[(round + 1) % 3]!, user),
        updateChannelStockRules(ctx, org, connections[round % 3]!, { safetyBuffer: round % 2, channelLimit: round % 3 ? null : 3 }, user),
        ...connections.map((connectionId) => importOrder(ctx, org, connectionId, buildOrder({ lines: reversedLines() }))),
        importOrder(ctx, org, connections[round % 3]!, buildOrder({ lines: reversedLines(), facts: [fact(`cancel-${round}`, 'cancelled')] })),
        setStock(ctx, org, productIds[round % skus.length]!, 30 + round, user, round % 2 ? north : main),
        setStock(ctx, org, productIds[(round + 1) % skus.length]!, 38 - round, user, round % 2 ? main : north),
        updateWarehouse(ctx, org, north, { name: `North ${round}`, priority: round % 2 ? 0 : 5 }, user),
        setWarehouseActive(ctx, org, spare, round % 2 === 1, user),
        upsertOffers(ctx, org, connections[round % 3]!, offers(true), new Date()),
      ])
    }

    expect(await watcher.stop()).toBeGreaterThan(0)
    // Moves (most of them succeeding), deactivations and Channel choice changes really ran alongside the rest.
    expect(outcome.moved).toBeGreaterThan(outcome.refused)
    expect(outcome.moved).toBeGreaterThanOrEqual(20)
    expect(await ctx.db.eventLog.count({ where: { organizationId: org, type: 'order.reservation_moved' } })).toBe(outcome.moved)
    for (const type of ['warehouse.deactivated', 'connection.warehouses_changed'] as const) {
      expect(await ctx.db.eventLog.count({ where: { organizationId: org, type } })).toBeGreaterThan(0)
    }

    ctx.queue.waiting.length = 0
    const run = { attempt: 1, maxAttempts: 5, retriedLater: 0 }
    for (const connectionId of connections) await stockPushJob.handler(ctx, { organizationId: org, connectionId }, run)

    const rules = await ctx.db.connection.findMany({ where: { organizationId: org }, select: { id: true, safetyBuffer: true, channelLimit: true } })
    const linked = await ctx.db.offer.findMany({ where: { organizationId: org, productId: { not: null } } })
    expect(linked).toHaveLength(connections.length * skus.length)
    for (const offer of linked) {
      const warehouseIds = await channelWarehouseIds(ctx.db, org, offer.connectionId)
      const perWarehouse = [...(await getWarehouseAvailability(ctx.db, org, offer.productId!, warehouseIds)).values()].map((value) => value.available)
      const base = channelWarehousesAvailable(perWarehouse)
      expect(offer.stockPushedSeq).toBe(offer.stockPushSeq)
      expect(offer.lastPushedAvailable).toBe(channelAvailable(base, rules.find((rule) => rule.id === offer.connectionId)!))
      expect(offer.lastPushedAvailable).toBeGreaterThanOrEqual(0)
      expect(offer.lastPushedAvailable).toBeLessThanOrEqual(Math.max(0, ...perWarehouse))
    }
    // The spare Warehouse never got a Reservation or Stock, and every Reservation sits in one Warehouse.
    expect(await ctx.db.reservation.count({ where: { organizationId: org, warehouseId: spare } })).toBe(0)
    expect(await ctx.db.reservation.count({ where: { organizationId: org, warehouseId: { notIn: [main, north] } } })).toBe(0)
  })
})
