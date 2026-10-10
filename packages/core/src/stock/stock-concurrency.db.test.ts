import { createDb, type Db } from '@hanza/db'
import { describe, expect, it } from 'vitest'
import { upsertOffers } from '../catalog/offers'
import { createProduct } from '../catalog/products'
import { isUniqueViolation } from '../errors'
import { updateChannelStockRules } from '../connections/stock-rules'
import { failSyncRun, finishSyncRun } from '../connections/sync-state'
import { stockPushJob } from '../jobs/stock-push'
import { changeOrderStatus } from '../orders/change-status'
import { importOrder } from '../orders/import'
import { applyOrderUpdate } from '../orders/update'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, createTestConnection, fact, orderLine, testChannel, user } from '../testing/fixtures'
import { uniqueApplicationName, untilLockWait, watchLockWaits } from '../testing/lock-waits'
import { TX_OPTIONS } from '../transaction'
import { getAvailability } from './availability'
import { channelAvailable } from './channel-available'
import { reassertOrderStock } from './push'
import { setStock } from './set-stock'

// Real parallel transactions against Postgres: every call below runs on its own
// pooled connection, and `watchLockWaits` proves they actually contended for
// the Stock row lock instead of happening to run one after another. Only this
// file's sessions (its own `application_name`) are counted.

const applicationName = uniqueApplicationName('hanza-stock-concurrency')

describe.skipIf(!databaseUrl)('Stock and Reservations under concurrency', () => {
  const context = useTestContext({ applicationName, connectors: [testChannel] })

  async function setup(stock: number) {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const connectionId = await createTestConnection(ctx, org)
    const { productId } = await createProduct(ctx, org, { sku: 'HOT', name: 'Last item', stock }, user)
    await upsertOffers(ctx, org, connectionId, [{ externalId: 'hot-offer', sku: 'HOT', name: 'Offer', url: null }], new Date())
    const order = () => buildOrder({ lines: [orderLine('l1', { sku: 'HOT', quantity: 1 })] })
    return { ctx, org, connectionId, productId, order }
  }

  it('(1) 20 parallel imports against Stock 10: exactly 10 Shortages, Available −10', async () => {
    const { ctx, org, connectionId, productId, order } = await setup(10)
    const watcher = watchLockWaits(databaseUrl!, applicationName)

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
    const watcher = watchLockWaits(databaseUrl!, applicationName)

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
    await untilLockWait(holder, applicationName)
    expect(importDone).toBe(false)
    release()
    await writer

    const { orderId } = await imported
    // Read before the lock, Available would still have been 1 and no Shortage recorded.
    expect((await ctx.db.orderLine.findFirstOrThrow({ where: { orderId } })).shortage).toBe(true)
    expect((await getAvailability(ctx.db, org, [productId])).get(productId)?.available).toBe(-1)
    await holder.$disconnect()
  })
  it('(6) mixed load with Channel stock rules: no deadlock, and every Offer ends at its Channel Available', async () => {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const connections = [await createTestConnection(ctx, org, 'A'), await createTestConnection(ctx, org, 'B')]
    const skus = ['MIX-1', 'MIX-2', 'MIX-3', 'MIX-4']
    const productIds: string[] = []
    for (const sku of skus) productIds.push((await createProduct(ctx, org, { sku, name: sku, stock: 6 }, user)).productId)
    const offers = (reverse: boolean) =>
      (reverse ? [...skus].reverse() : skus).map((sku) => ({ externalId: `offer-${sku}`, sku, name: sku, url: null }))
    for (const connectionId of connections) {
      await upsertOffers(ctx, org, connectionId, offers(false), new Date())
      // Creates the sync state rows up front, so the parallel health changes below only update them.
      await finishSyncRun(ctx, org, connectionId, 'orders_pull', {})
    }
    // Lines in reverse SKU order: importOrder must still lock Stock rows sorted by Product.
    const reversedLines = () => [...skus].reverse().map((sku, i) => orderLine(`l${i}`, { sku, quantity: 1 + (i % 2) }))

    for (let round = 0; round < 6; round++) {
      await Promise.all([
        updateChannelStockRules(ctx, org, connections[0]!, { safetyBuffer: round % 3, channelLimit: round % 2 ? 3 : null }, user),
        updateChannelStockRules(ctx, org, connections[1]!, { safetyBuffer: (round + 1) % 2, channelLimit: round % 3 === 0 ? null : 1 + round }, user),
        ...connections.flatMap((connectionId) => [1, 2].map(() => importOrder(ctx, org, connectionId, buildOrder({ lines: reversedLines() })))),
        importOrder(ctx, org, connections[round % 2]!, buildOrder({ lines: reversedLines(), facts: [fact(`cancel-${round}`, 'cancelled')] })),
        setStock(ctx, org, productIds[round % skus.length]!, 4 + round, user),
        setStock(ctx, org, productIds[(round + 2) % skus.length]!, 9 - round, user),
        upsertOffers(ctx, org, connections[0]!, offers(true), new Date()),
        upsertOffers(ctx, org, connections[1]!, offers(true), new Date()),
        failSyncRun(ctx, org, connections[round % 2]!, 'orders_pull', { kind: 'transient', message: 'down', health: 'failing' }),
        finishSyncRun(ctx, org, connections[(round + 1) % 2]!, 'orders_pull', { pulled: round }),
      ])
    }

    ctx.queue.waiting.length = 0
    const run = { attempt: 1, maxAttempts: 5, retriedLater: 0 }
    for (const connectionId of connections) await stockPushJob.handler(ctx, { organizationId: org, connectionId }, run)

    const availability = await getAvailability(ctx.db, org, productIds)
    const rules = await ctx.db.connection.findMany({ where: { organizationId: org }, select: { id: true, safetyBuffer: true, channelLimit: true } })
    const linked = await ctx.db.offer.findMany({ where: { organizationId: org, productId: { not: null } } })
    expect(linked).toHaveLength(connections.length * skus.length)
    for (const offer of linked) {
      const connectionRules = rules.find((connection) => connection.id === offer.connectionId)!
      const available = availability.get(offer.productId!)!.available
      expect(offer.stockPushedSeq).toBe(offer.stockPushSeq)
      expect(offer.lastPushedAvailable).toBe(Math.max(0, Math.min(available - connectionRules.safetyBuffer, connectionRules.channelLimit ?? Infinity)))
      expect(offer.lastPushedAvailable).toBe(channelAvailable(available, connectionRules))
    }
    // Something was oversold along the way, so the clamp to zero was exercised too.
    expect([...availability.values()].some((value) => value.available < 0)).toBe(true)
  })

  it('(7) facts for Orders Hanza has, the marks of status pushes, stock pushes and Offer pulls at once: no deadlock, and every Offer ends at its Channel Available', async () => {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const connections = [await createTestConnection(ctx, org, 'A'), await createTestConnection(ctx, org, 'B')]
    const skus = ['RE-1', 'RE-2', 'RE-3', 'RE-4']
    const productIds: string[] = []
    for (const sku of skus) productIds.push((await createProduct(ctx, org, { sku, name: sku, stock: 40 }, user)).productId)
    const offers = (reverse: boolean) =>
      (reverse ? [...skus].reverse() : skus).map((sku) => ({ externalId: `offer-${sku}`, sku, name: sku, url: null }))
    for (const connectionId of connections) {
      await upsertOffers(ctx, org, connectionId, offers(false), new Date())
      // The Order feed counts as read, so the stock pushes below really push (ADR 0023).
      await finishSyncRun(ctx, org, connectionId, 'orders_pull', {})
    }
    // Lines in reverse SKU order, each naming its Offer: the marks must still lock Offers in id order.
    const lines = () => [...skus].reverse().map((sku, i) => orderLine(`l${i}`, { offerExternalId: `offer-${sku}`, sku }))
    const run = { attempt: 1, maxAttempts: 5, retriedLater: 0 }
    const watcher = watchLockWaits(databaseUrl!, applicationName)

    for (let round = 0; round < 6; round++) {
      // Orders Hanza has, four per Channel; each is reported again, or has its status pushed, in this round.
      const known: Array<{ connectionId: string; order: ReturnType<typeof buildOrder>; orderId: string }> = []
      for (const connectionId of connections) {
        for (let i = 0; i < 4; i++) {
          const order = buildOrder({ lines: lines(), awaitingPayment: i === 0 })
          known.push({ connectionId, order, orderId: (await importOrder(ctx, org, connectionId, order)).orderId })
        }
      }
      await Promise.all([
        ...known.flatMap(({ connectionId, order, orderId }, i): Array<Promise<unknown>> => {
          // A payment (no Stock moves), a cancellation by the Channel, a status push after a cancellation by a
          // person, and a status push next to the Channel's own shipment.
          if (i % 4 === 0) return [importOrder(ctx, org, connectionId, { ...order, awaitingPayment: false, facts: [fact('paid', 'paid')] })]
          const cancelled = fact('cancelled', 'cancelled')
          if (i % 4 === 1) return [applyOrderUpdate(ctx, org, connectionId, { kind: 'update', externalId: order.externalId, facts: [cancelled] })]
          if (i % 4 === 2) return [changeOrderStatus(ctx, org, orderId, 'cancelled', user), reassertOrderStock(ctx, org, orderId)]
          return [importOrder(ctx, org, connectionId, { ...order, facts: [fact('shipped', 'shipped')] }), reassertOrderStock(ctx, org, orderId)]
        }),
        ...connections.map((connectionId) => importOrder(ctx, org, connectionId, buildOrder({ lines: lines() }))),
        ...connections.map((connectionId) => stockPushJob.handler(ctx, { organizationId: org, connectionId }, run)),
        ...connections.map((connectionId) => upsertOffers(ctx, org, connectionId, offers(true), new Date())),
        updateChannelStockRules(ctx, org, connections[round % 2]!, { safetyBuffer: round % 3, channelLimit: round % 2 ? 30 : null }, user),
        setStock(ctx, org, productIds[round % skus.length]!, 40 + round, user),
      ])
    }

    expect(await watcher.stop()).toBeGreaterThan(0)
    ctx.queue.waiting.length = 0
    for (const connectionId of connections) await stockPushJob.handler(ctx, { organizationId: org, connectionId }, run)

    const availability = await getAvailability(ctx.db, org, productIds)
    const rules = await ctx.db.connection.findMany({ where: { organizationId: org }, select: { id: true, safetyBuffer: true, channelLimit: true } })
    const linked = await ctx.db.offer.findMany({ where: { organizationId: org, productId: { not: null } } })
    expect(linked).toHaveLength(connections.length * skus.length)
    for (const offer of linked) {
      expect(offer.stockPushedSeq).toBe(offer.stockPushSeq)
      expect(offer.lastPushedAvailable).toBe(
        channelAvailable(availability.get(offer.productId!)!.available, rules.find((connection) => connection.id === offer.connectionId)!),
      )
    }
  })
})
