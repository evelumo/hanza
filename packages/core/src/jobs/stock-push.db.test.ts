import { defineConnector, type StockLevel } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createProduct, createProductsFromOffers, getProduct } from '../catalog/products'
import { linkOffer, unlinkOffer, upsertOffers } from '../catalog/offers'
import { createConnection } from '../connections/connections'
import { updateChannelStockRules } from '../connections/stock-rules'
import { failSyncRun } from '../connections/sync-state'
import { importOrder } from '../orders/import'
import { setStock } from '../stock/set-stock'
import { ensureDefaultWarehouse } from '../stock/warehouse'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, orderLine, uniqueSku, user } from '../testing/fixtures'
import { stockPushJob } from './stock-push'

const pushes: StockLevel[][] = []
/** Runs once inside the next `stock.push` call, after the levels are recorded. */
let duringNextPush: (() => Promise<void>) | undefined

const channel = defineConnector({
  id: 'push-channel',
  name: 'Push channel',
  kind: 'marketplace',
  auth: { type: 'none' },
  configSchema: z.object({}),
  credentialsSchema: z.object({}),
  capabilities: {
    async 'offers.pull'() {
      return { items: [], nextCursor: null, hasMore: false }
    },
    async 'orders.pull'() {
      return { items: [], nextCursor: null, hasMore: false }
    },
    async 'stock.push'(_ctx, levels) {
      pushes.push(levels)
      const hook = duringNextPush
      duringNextPush = undefined
      await hook?.()
    },
  },
})

const run = { attempt: 1, maxAttempts: 5, retriedLater: 0 }

/** Forgets every request so far, including waiting ones that would swallow a new request with the same key. */
function clearQueue(ctx: { queue: { enqueued: unknown[]; waiting: unknown[] } }) {
  ctx.queue.enqueued.length = 0
  ctx.queue.waiting.length = 0
}

describe.skipIf(!databaseUrl)('stock.push', () => {
  const context = useTestContext({ connectors: [channel] })

  async function setup() {
    const ctx = context()
    const organizationId = await createTestOrganization(ctx.db)
    const { connectionId } = await createConnection(
      ctx,
      organizationId,
      { connectorId: 'push-channel', name: 'Channel', config: {}, credentials: {} },
      user,
    )
    return { ctx, organizationId, connectionId }
  }

  it('pushes max(0, Available) of each pending linked Offer once, then marks it pushed', async () => {
    const { ctx, organizationId, connectionId } = await setup()
    const inStock = uniqueSku()
    const oversold = uniqueSku()
    await createProduct(ctx, organizationId, { sku: inStock, name: 'A', stock: 4 }, user)
    await createProduct(ctx, organizationId, { sku: oversold, name: 'B', stock: 0 }, user)
    await upsertOffers(
      ctx,
      organizationId,
      connectionId,
      [
        { externalId: 'offer-a', sku: inStock, name: 'A', url: null },
        { externalId: 'offer-b', sku: oversold, name: 'B', url: null },
        { externalId: 'offer-c', sku: null, name: 'C', url: null },
      ],
      new Date(),
    )
    await importOrder(ctx, organizationId, connectionId, buildOrder({ lines: [orderLine('l1', { sku: oversold, quantity: 2 })] }))

    pushes.length = 0
    await stockPushJob.handler(ctx, { organizationId, connectionId }, run)
    expect(pushes).toEqual([
      expect.arrayContaining([
        { offerExternalId: 'offer-a', sku: inStock, available: 4 },
        { offerExternalId: 'offer-b', sku: oversold, available: 0 },
      ]),
    ])
    expect(pushes[0]).toHaveLength(2)
    const offers = await ctx.db.offer.findMany({ where: { organizationId, productId: { not: null } }, orderBy: { externalId: 'asc' } })
    expect(offers.map((offer) => [offer.externalId, offer.lastPushedAvailable, offer.stockPushSeq === offer.stockPushedSeq])).toEqual([
      ['offer-a', 4, true],
      ['offer-b', 0, true],
    ])
    expect((await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId } })).health).toBe('ok')

    pushes.length = 0
    await stockPushJob.handler(ctx, { organizationId, connectionId }, run)
    expect(pushes).toEqual([])
  })

  it('pushes Channel Available: the Safety buffer and Channel limit of this Connection, and again after they change', async () => {
    const { ctx, organizationId, connectionId } = await setup()
    const plenty = uniqueSku()
    const few = uniqueSku()
    await createProduct(ctx, organizationId, { sku: plenty, name: 'A', stock: 20 }, user)
    await createProduct(ctx, organizationId, { sku: few, name: 'B', stock: 2 }, user)
    await upsertOffers(
      ctx,
      organizationId,
      connectionId,
      [
        { externalId: 'offer-plenty', sku: plenty, name: 'A', url: null },
        { externalId: 'offer-few', sku: few, name: 'B', url: null },
      ],
      new Date(),
    )
    await updateChannelStockRules(ctx, organizationId, connectionId, { safetyBuffer: 3, channelLimit: 10 }, user)

    pushes.length = 0
    await stockPushJob.handler(ctx, { organizationId, connectionId }, run)
    const sorted = (levels: StockLevel[] | undefined) => [...(levels ?? [])].sort((a, b) => a.offerExternalId.localeCompare(b.offerExternalId))
    // 20 − 3 = 17, capped at 10; 2 − 3 is below zero, so 0.
    expect(sorted(pushes[0])).toEqual([
      { offerExternalId: 'offer-few', sku: few, available: 0 },
      { offerExternalId: 'offer-plenty', sku: plenty, available: 10 },
    ])
    const offers = await ctx.db.offer.findMany({ where: { organizationId, connectionId }, orderBy: { externalId: 'asc' } })
    expect(offers.map((offer) => [offer.externalId, offer.lastPushedAvailable])).toEqual([
      ['offer-few', 0],
      ['offer-plenty', 10],
    ])

    await updateChannelStockRules(ctx, organizationId, connectionId, { safetyBuffer: 0, channelLimit: null }, user)
    pushes.length = 0
    await stockPushJob.handler(ctx, { organizationId, connectionId }, run)
    expect(sorted(pushes[0])).toEqual([
      { offerExternalId: 'offer-few', sku: few, available: 2 },
      { offerExternalId: 'offer-plenty', sku: plenty, available: 20 },
    ])
  })

  it('a settings change during a running push leaves the Offer pending, and the same run then pushes the new number', async () => {
    const { ctx, organizationId, connectionId } = await setup()
    const sku = uniqueSku()
    await createProduct(ctx, organizationId, { sku, name: 'A', stock: 5 }, user)
    await upsertOffers(ctx, organizationId, connectionId, [{ externalId: 'offer-a', sku, name: 'A', url: null }], new Date())
    // The rules commit after this push read the Offer's sequence and the old rules, before it marks the Offer pushed.
    duringNextPush = () => updateChannelStockRules(ctx, organizationId, connectionId, { safetyBuffer: 0, channelLimit: 2 }, user)

    pushes.length = 0
    await stockPushJob.handler(ctx, { organizationId, connectionId }, run)

    expect(duringNextPush).toBeUndefined()
    expect(pushes).toEqual([[{ offerExternalId: 'offer-a', sku, available: 5 }], [{ offerExternalId: 'offer-a', sku, available: 2 }]])
    const offer = await ctx.db.offer.findFirstOrThrow({ where: { organizationId, connectionId, externalId: 'offer-a' } })
    expect(offer.stockPushedSeq).toBe(offer.stockPushSeq)
    expect(offer.lastPushedAvailable).toBe(2)
  })

  it('with nothing to push it calls nothing and records only that it finished', async () => {
    const { ctx, organizationId, connectionId } = await setup()
    await failSyncRun(ctx, organizationId, connectionId, 'stock_push', { kind: 'auth_expired', message: '401', health: 'auth_expired' })
    const longAgo = new Date('2026-01-01T00:00:00Z')
    await ctx.db.syncState.updateMany({ where: { connectionId, stream: 'stock_push' }, data: { lastFinishedAt: longAgo } })

    pushes.length = 0
    await stockPushJob.handler(ctx, { organizationId, connectionId }, run)
    expect(pushes).toEqual([])
    expect((await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId } })).health).toBe('auth_expired')
    const state = await ctx.db.syncState.findFirstOrThrow({ where: { connectionId, stream: 'stock_push' } })
    expect(state).toMatchObject({ lastResult: null, lastSucceededAt: null, lastErrorKind: 'auth_expired', lastError: '401' })
    expect(state.lastFinishedAt!.getTime()).toBeGreaterThan(longAgo.getTime())
  })

  it('stops after 10 full batches of 100 and enqueues itself for the rest', async () => {
    const { ctx, organizationId, connectionId } = await setup()
    const prefix = uniqueSku('BULK')
    const products = await ctx.db.product.createManyAndReturn({
      data: Array.from({ length: 1_050 }, (_, i) => ({ organizationId, sku: `${prefix}-${i}`, name: `P${i}` })),
      select: { id: true, sku: true },
    })
    // Stock rows of their own: a Product without one has unset Stock and is never pushed (#137).
    const warehouseId = await ensureDefaultWarehouse(ctx.db, organizationId)
    await ctx.db.stock.createMany({ data: products.map((product) => ({ organizationId, productId: product.id, warehouseId, units: 0 })) })
    await ctx.db.offer.createMany({
      data: products.map((product) => ({
        organizationId,
        connectionId,
        externalId: `offer-${product.sku}`,
        sku: product.sku,
        name: product.sku,
        productId: product.id,
        linkedBy: 'sku' as const,
        stockPushSeq: 1,
        lastSeenAt: new Date(),
      })),
    })

    pushes.length = 0
    await stockPushJob.handler(ctx, { organizationId, connectionId }, run)
    expect(pushes.map((levels) => levels.length)).toEqual(Array(10).fill(100))
    expect(await ctx.db.offer.count({ where: { connectionId, stockPushedSeq: 0 } })).toBe(50)
    expect(ctx.queue.waiting.filter((job) => (job.payload as { connectionId: string }).connectionId === connectionId)).toEqual([
      { name: 'stock.push', payload: { organizationId, connectionId }, options: { coalesceKey: `stock.push:${connectionId}` } },
    ])
    expect((await ctx.db.syncState.findFirstOrThrow({ where: { connectionId, stream: 'stock_push' } })).lastResult).toEqual({ pushed: 1_000, rejected: 0, skipped: 0 })
  })

  it('leaves out Offers of a Product with unset Stock, even after an Order reserves it, and pushes them once Stock is saved (#137)', async () => {
    const { ctx, organizationId, connectionId } = await setup()
    const sku = uniqueSku('UNSET')
    const other = uniqueSku('UNSET')
    await upsertOffers(
      ctx,
      organizationId,
      connectionId,
      [
        { externalId: 'offer-u', sku, name: 'U', url: null },
        { externalId: 'offer-z', sku: other, name: 'Z', url: null },
      ],
      new Date(),
    )
    const offer = (externalId: string) => ctx.db.offer.findFirstOrThrow({ where: { organizationId, connectionId, externalId } })
    clearQueue(ctx)
    const { created } = await createProductsFromOffers(ctx, organizationId, [(await offer('offer-u')).id, (await offer('offer-z')).id], user)
    const [productId, otherId] = created as [string, string]
    // Nothing to send: no Stock row, the Offers are not marked and no push is requested.
    expect(await ctx.db.stock.count({ where: { organizationId, productId: { in: created } } })).toBe(0)
    expect(await offer('offer-u')).toMatchObject({ productId, stockPushSeq: 0, stockPushedSeq: 0 })
    expect(ctx.queue.enqueued.filter((job) => job.name === 'stock.push')).toEqual([])

    // An Order reserves against the unset Stock (a Shortage) and marks the Offer; the push still leaves it out.
    await importOrder(ctx, organizationId, connectionId, buildOrder({ lines: [orderLine('l1', { sku, quantity: 2 })] }))
    expect((await offer('offer-u')).stockPushSeq).toBe(1)
    pushes.length = 0
    await stockPushJob.handler(ctx, { organizationId, connectionId }, run)
    expect(pushes).toEqual([])
    // Left out counts as handled, so the Offer does not wait in every batch.
    expect(await offer('offer-u')).toMatchObject({ stockPushedSeq: 1, lastPushedAt: null })
    const detail = await getProduct(ctx, organizationId, productId)
    expect(detail).toMatchObject({ stockSet: false, stock: 0, reserved: 2, available: -2 })
    expect(detail?.offers.map((row) => row.stockStatus)).toEqual(['unset'])

    // Saving the Stock, 0 included, makes it a number to send.
    await setStock(ctx, organizationId, productId, 5, user)
    await setStock(ctx, organizationId, otherId, 0, user)
    expect((await ctx.db.eventLog.findFirstOrThrow({ where: { organizationId, type: 'stock.set', subjectId: otherId } })).payload).toMatchObject({
      from: null,
      to: 0,
    })
    pushes.length = 0
    await stockPushJob.handler(ctx, { organizationId, connectionId }, run)
    expect(pushes).toHaveLength(1)
    expect(pushes[0]).toHaveLength(2)
    expect(pushes[0]).toEqual(
      expect.arrayContaining([
        { offerExternalId: 'offer-u', sku, available: 3 },
        { offerExternalId: 'offer-z', sku: other, available: 0 },
      ]),
    )
  })

  it('linking an Offer by hand to a Product with unset Stock requests no push and sends nothing (#137)', async () => {
    const { ctx, organizationId, connectionId } = await setup()
    const sku = uniqueSku('UNSET')
    await upsertOffers(
      ctx,
      organizationId,
      connectionId,
      [
        { externalId: 'offer-source', sku, name: 'Source', url: null },
        { externalId: 'offer-manual', sku: null, name: 'Manual', url: null },
      ],
      new Date(),
    )
    const source = await ctx.db.offer.findFirstOrThrow({ where: { organizationId, externalId: 'offer-source' } })
    const manual = await ctx.db.offer.findFirstOrThrow({ where: { organizationId, externalId: 'offer-manual' } })
    const [productId] = (await createProductsFromOffers(ctx, organizationId, [source.id], user)).created as [string]
    clearQueue(ctx)

    await linkOffer(ctx, organizationId, manual.id, productId, user)

    expect(ctx.queue.enqueued.filter((job) => job.name === 'stock.push')).toEqual([])
    pushes.length = 0
    await stockPushJob.handler(ctx, { organizationId, connectionId }, run)
    expect(pushes).toEqual([])

    // With Stock saved, the same link pushes as it always did.
    await setStock(ctx, organizationId, productId, 2, user)
    const { productId: stocked } = await createProduct(ctx, organizationId, { sku: uniqueSku('SET'), name: 'Set', stock: 4 }, user)
    await unlinkOffer(ctx, organizationId, manual.id, user)
    clearQueue(ctx)
    await linkOffer(ctx, organizationId, manual.id, stocked, user)
    expect(ctx.queue.enqueued.filter((job) => job.name === 'stock.push')).toEqual([
      { name: 'stock.push', payload: { organizationId, connectionId }, options: { coalesceKey: `stock.push:${connectionId}` } },
    ])
    pushes.length = 0
    await stockPushJob.handler(ctx, { organizationId, connectionId }, run)
    expect(pushes.flat()).toEqual(
      expect.arrayContaining([
        { offerExternalId: 'offer-manual', sku: null, available: 4 },
        { offerExternalId: 'offer-source', sku, available: 2 },
      ]),
    )
  })

  it('a payload naming another organization does nothing', async () => {
    const { ctx, organizationId, connectionId } = await setup()
    const sku = uniqueSku()
    await createProduct(ctx, organizationId, { sku, name: 'A', stock: 1 }, user)
    await upsertOffers(ctx, organizationId, connectionId, [{ externalId: 'offer-a', sku, name: 'A', url: null }], new Date())
    const other = await createTestOrganization(ctx.db)

    pushes.length = 0
    await stockPushJob.handler(ctx, { organizationId: other, connectionId }, run)
    expect(pushes).toEqual([])
    expect(await ctx.db.syncState.count({ where: { connectionId } })).toBe(0)
  })
})
