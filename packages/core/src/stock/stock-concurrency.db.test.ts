import { createDb, type Db } from '@hanza/db'
import { describe, expect, it } from 'vitest'
import { upsertOffers } from '../catalog/offers'
import { createProduct } from '../catalog/products'
import { isUniqueViolation } from '../errors'
import { changeOrderStatus } from '../orders/change-status'
import { importOrder } from '../orders/import'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, createTestConnection, orderLine, user } from '../testing/fixtures'
import { TX_OPTIONS } from '../transaction'
import { getAvailability } from './availability'

// Real parallel transactions against Postgres: every call below runs on its own
// pooled connection, and `watchLockWaits` proves they actually contended for
// the Stock row lock instead of happening to run one after another.

function watchLockWaits(url: string): { stop(): Promise<number> } {
  const observer: Db = createDb(url)
  let running = true
  let max = 0
  const loop = (async () => {
    while (running) {
      const [row] = await observer.$queryRaw<Array<{ waiting: bigint }>>`
        SELECT count(*) AS "waiting" FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`
      max = Math.max(max, Number(row?.waiting ?? 0))
    }
  })()
  return {
    async stop() {
      running = false
      await loop
      await observer.$disconnect()
      return max
    },
  }
}

describe.skipIf(!databaseUrl)('Stock and Reservations under concurrency', () => {
  const context = useTestContext()

  async function setup(stock: number) {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const connectionId = await createTestConnection(ctx, org)
    const { productId } = await createProduct(ctx, org, { sku: 'HOT', name: 'Ostatnia sztuka', stock }, user)
    await upsertOffers(ctx, org, connectionId, [{ externalId: 'hot-offer', sku: 'HOT', name: 'Oferta', url: null }], new Date())
    const order = () => buildOrder({ lines: [orderLine('l1', { sku: 'HOT', quantity: 1 })] })
    return { ctx, org, connectionId, productId, order }
  }

  it('(1) 20 parallel imports against Stock 10: exactly 10 Shortages, Available −10', async () => {
    const { ctx, org, connectionId, productId, order } = await setup(10)
    const watcher = watchLockWaits(databaseUrl!)

    const results = await Promise.all(Array.from({ length: 20 }, () => importOrder(ctx, org, connectionId, order())))

    expect(await watcher.stop()).toBeGreaterThan(0)
    expect(results.every((result) => result.created)).toBe(true)
    const lines = await ctx.db.orderLine.findMany({ where: { organizationId: org } })
    expect(lines.filter((line) => line.shortage)).toHaveLength(10)
    expect(lines.filter((line) => !line.shortage)).toHaveLength(10)
    expect(await ctx.db.reservation.count({ where: { organizationId: org, status: 'open' } })).toBe(20)
    expect(await ctx.db.order.count({ where: { organizationId: org, attentionReasons: { has: 'shortage' } } })).toBe(10)
    expect((await getAvailability(ctx.db, org, [productId])).get(productId)).toEqual({ stock: 10, reserved: 20, available: -10 })
    // Every import bumped the Offer once, inside its own transaction.
    expect((await ctx.db.offer.findFirstOrThrow({ where: { organizationId: org } })).stockPushSeq).toBe(21)
  })

  it('(2) two parallel imports of the last unit: exactly one Shortage', async () => {
    const { ctx, org, connectionId, productId, order } = await setup(1)

    await Promise.all([importOrder(ctx, org, connectionId, order()), importOrder(ctx, org, connectionId, order())])

    const lines = await ctx.db.orderLine.findMany({ where: { organizationId: org } })
    expect(lines.map((line) => line.shortage).sort()).toEqual([false, true])
    expect((await getAvailability(ctx.db, org, [productId])).get(productId)?.available).toBe(-1)
  })

  it('(3) ten Orders shipped in parallel from Stock 0: no lost decrement', async () => {
    const { ctx, org, connectionId, productId, order } = await setup(0)
    const orderIds: string[] = []
    for (let i = 0; i < 10; i++) orderIds.push((await importOrder(ctx, org, connectionId, order())).orderId)
    const watcher = watchLockWaits(databaseUrl!)

    await Promise.all(orderIds.map((orderId) => changeOrderStatus(ctx, org, orderId, 'shipped', user)))

    expect(await watcher.stop()).toBeGreaterThan(0)
    const stock = await ctx.db.stock.findFirstOrThrow({ where: { organizationId: org, productId } })
    expect(stock.units).toBe(-10)
    expect(await ctx.db.reservation.count({ where: { organizationId: org, status: 'consumed' } })).toBe(10)
    expect(await ctx.db.eventLog.count({ where: { organizationId: org, type: 'stock.consumed' } })).toBe(10)
    expect((await getAvailability(ctx.db, org, [productId])).get(productId)).toEqual({ stock: -10, reserved: 0, available: -10 })
  })

  it('(4) the same Order imported twice in parallel: one Order, one set of Reservations', async () => {
    const { ctx, org, connectionId, productId, order } = await setup(5)
    const same = buildOrder({ lines: [orderLine('l1', { sku: 'HOT', quantity: 2 }), orderLine('l2', { sku: 'HOT', quantity: 1 })] })
    void order

    const settled = await Promise.allSettled([importOrder(ctx, org, connectionId, same), importOrder(ctx, org, connectionId, same)])

    const failed = settled.filter((result) => result.status === 'rejected')
    expect(failed.length).toBeLessThanOrEqual(1)
    for (const failure of failed) expect(isUniqueViolation(failure.reason)).toBe(true)
    // The job would retry: the retry takes the "already exists" path and changes nothing.
    const before = await ctx.db.eventLog.count({ where: { organizationId: org } })
    expect(await importOrder(ctx, org, connectionId, same)).toMatchObject({ created: false, factsApplied: 0 })
    expect(await ctx.db.eventLog.count({ where: { organizationId: org } })).toBe(before)

    expect(await ctx.db.order.count({ where: { organizationId: org } })).toBe(1)
    expect(await ctx.db.orderLine.count({ where: { organizationId: org } })).toBe(2)
    expect(await ctx.db.reservation.count({ where: { organizationId: org } })).toBe(2)
    expect((await getAvailability(ctx.db, org, [productId])).get(productId)).toEqual({ stock: 5, reserved: 3, available: 2 })
  })

  it('(5) a Reservation waits for a concurrent Stock writer and reads Available after it commits', async () => {
    const { ctx, org, connectionId, productId, order } = await setup(1)
    const holder: Db = createDb(databaseUrl!)
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let locked!: () => void
    const isLocked = new Promise<void>((resolve) => (locked = resolve))

    // Another writer holds the Stock row lock and takes the last unit before it commits.
    const writer = holder.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "stock" WHERE "organizationId" = ${org} AND "productId" = ${productId} FOR UPDATE`
      locked()
      await released
      await tx.$executeRaw`UPDATE "stock" SET "units" = 0, "updatedAt" = now() WHERE "organizationId" = ${org} AND "productId" = ${productId}`
    }, TX_OPTIONS)
    await isLocked

    let importDone = false
    const imported = importOrder(ctx, org, connectionId, order()).then((result) => {
      importDone = true
      return result
    })
    // Wait until the import is blocked on the lock, then let the writer commit.
    for (let i = 0; i < 200; i++) {
      const [row] = await holder.$queryRaw<Array<{ waiting: bigint }>>`
        SELECT count(*) AS "waiting" FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`
      if (Number(row?.waiting) > 0) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(importDone).toBe(false)
    release()
    await writer

    const { orderId } = await imported
    // Read before the lock, Available would still have been 1 and no Shortage recorded.
    expect((await ctx.db.orderLine.findFirstOrThrow({ where: { orderId } })).shortage).toBe(true)
    expect((await getAvailability(ctx.db, org, [productId])).get(productId)?.available).toBe(-1)
    await holder.$disconnect()
  })
})
