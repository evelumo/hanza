import { defineConnector, type StockLevel } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createProduct } from '../catalog/products'
import { upsertOffers } from '../catalog/offers'
import { createConnection } from '../connections/connections'
import { updateChannelStockRules } from '../connections/stock-rules'
import { failSyncRun } from '../connections/sync-state'
import { importOrder } from '../orders/import'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, orderFeedCaughtUp, orderLine, uniqueSku, user } from '../testing/fixtures'
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

describe.skipIf(!databaseUrl)('stock.push', () => {
  const context = useTestContext({ connectors: [channel] })

  /** A Connection whose Order feed has caught up, unless `fresh` (#125). */
  async function setup({ fresh = false } = {}) {
    const ctx = context()
    const organizationId = await createTestOrganization(ctx.db)
    const { connectionId } = await createConnection(
      ctx,
      organizationId,
      { connectorId: 'push-channel', name: 'Channel', config: {}, credentials: {} },
      user,
    )
    if (!fresh) await orderFeedCaughtUp(ctx, organizationId, connectionId)
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

  it('a payload naming another organization does nothing', async () => {
    const { ctx, organizationId, connectionId } = await setup({ fresh: true })
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
