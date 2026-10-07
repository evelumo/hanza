import { CursorExpiredError, defineConnector, type Order, type OrderUpdate, type PullResult } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createConnection } from '../connections/connections'
import type { JobRunInfo } from '../jobs'
import { importOrder } from '../orders/import'
import { getAvailability } from '../stock/availability'
import { ensureDefaultWarehouse } from '../stock/warehouse'
import { PermanentJobError } from '../jobs'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, fact, orderLine, uniqueSku, user } from '../testing/fixtures'
import { ordersPullJob } from './orders-pull'

type Pull = (cursor: string | null) => Promise<PullResult<Order | OrderUpdate>>
let pull: Pull = async () => ({ items: [], nextCursor: null, hasMore: false })
let calls = 0

const channel = defineConnector({
  id: 'orders-pull-channel',
  name: 'Orders pull channel',
  kind: 'marketplace',
  auth: { type: 'none' },
  configSchema: z.object({}),
  credentialsSchema: z.object({}),
  capabilities: {
    async 'offers.pull'() {
      return { items: [], nextCursor: null, hasMore: false }
    },
    async 'orders.pull'(_ctx, cursor) {
      calls++
      return pull(cursor)
    },
    async 'stock.push'() {},
  },
})

const run: JobRunInfo = { attempt: 1, maxAttempts: 5, retriedLater: 0 }

describe.skipIf(!databaseUrl)('orders.pull', () => {
  const context = useTestContext({ connectors: [channel] })

  async function setup() {
    const ctx = context()
    const organizationId = await createTestOrganization(ctx.db)
    const { connectionId } = await createConnection(
      ctx,
      organizationId,
      { connectorId: 'orders-pull-channel', name: 'Channel', config: {}, credentials: {} },
      user,
    )
    const runPull = () => ordersPullJob.handler(ctx, { organizationId, connectionId, trigger: 'schedule' }, run)
    const waitingFor = () =>
      ctx.queue.waiting.filter((job) => (job.payload as { connectionId: string }).connectionId === connectionId)
    calls = 0
    return { ctx, organizationId, connectionId, runPull, waitingFor }
  }

  it('matches an Unmatched line whose Product appeared after the Order was imported, even with nothing new to pull', async () => {
    const { ctx, organizationId, connectionId, runPull } = await setup()
    const sku = uniqueSku()
    const { orderId } = await importOrder(ctx, organizationId, connectionId, buildOrder({ lines: [orderLine('l1', { sku, quantity: 2 })] }))
    // The Product is committed after the import matched the line and without a rematch of its own,
    // as when both happen at the same moment.
    const warehouseId = await ensureDefaultWarehouse(ctx.db, organizationId)
    const product = await ctx.db.product.create({ data: { organizationId, sku, name: 'New' } })
    await ctx.db.stock.create({ data: { organizationId, productId: product.id, warehouseId, units: 5 } })

    pull = async () => ({ items: [], nextCursor: null, hasMore: false })
    await runPull()
    const line = await ctx.db.orderLine.findFirstOrThrow({ where: { orderId }, include: { reservation: true } })
    expect(line.productId).toBe(product.id)
    expect(line.reservation).toMatchObject({ status: 'open', units: 2 })
    expect((await ctx.db.order.findFirstOrThrow({ where: { id: orderId } })).attentionReasons).toEqual([])
    expect((await getAvailability(ctx.db, organizationId, [product.id])).get(product.id)?.available).toBe(3)
  })

  it('stops after 20 pages, keeps the cursor and enqueues itself to continue', async () => {
    const { ctx, organizationId, connectionId, runPull, waitingFor } = await setup()
    pull = async (cursor) => {
      const page = cursor === null ? 0 : Number(cursor)
      return { items: [buildOrder({ externalId: `page-${page}` })], nextCursor: String(page + 1), hasMore: true }
    }
    await runPull()
    expect(calls).toBe(20)
    const sync = await ctx.db.syncState.findFirstOrThrow({ where: { connectionId, stream: 'orders_pull' } })
    expect(sync).toMatchObject({ cursor: '20', lastResult: { pulled: 20, imported: 20, factsApplied: 0, pages: 20 } })
    expect(waitingFor()).toEqual([
      {
        name: 'orders.pull',
        payload: { organizationId, connectionId, trigger: 'schedule' },
        options: { coalesceKey: `orders.pull:${connectionId}` },
      },
    ])

    // The continuation picks up at the saved cursor.
    ctx.queue.waiting.splice(0)
    pull = async (cursor) => {
      expect(cursor).toBe('20')
      return { items: [], nextCursor: '20', hasMore: false }
    }
    await runPull()
    expect(waitingFor()).toEqual([])
  })

  it('an expired cursor resets the feed to null with an Event, and the same run carries on from the open Orders', async () => {
    const { ctx, organizationId, connectionId, runPull } = await setup()
    await ctx.db.syncState.create({ data: { organizationId, connectionId, stream: 'orders_pull', cursor: 'e1:old' } })
    const seen: Array<string | null> = []
    pull = async (cursor) => {
      seen.push(cursor)
      if (cursor === 'e1:old') throw new CursorExpiredError('older than the journal')
      if (cursor === null) return { items: [buildOrder({ externalId: 'open-now' })], nextCursor: 'e1:new', hasMore: true }
      return { items: [], nextCursor: cursor, hasMore: false }
    }
    await runPull()

    expect(seen).toEqual(['e1:old', null, 'e1:new'])
    const sync = await ctx.db.syncState.findFirstOrThrow({ where: { connectionId, stream: 'orders_pull' } })
    expect(sync).toMatchObject({
      cursor: 'e1:new',
      lastErrorKind: null,
      lastResult: { pulled: 1, imported: 1, factsApplied: 0, pages: 2, feedRestarts: 1 },
    })
    const events = await ctx.db.eventLog.findMany({ where: { organizationId, type: 'connection.order_feed_restarted' } })
    expect(events.map((event) => [event.subjectType, event.subjectId, event.payload])).toEqual([['connection', connectionId, {}]])
    expect((await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId } })).health).toBe('ok')
  })

  it('an expired cursor for null, or a second one in the same run, fails the run as permanent', async () => {
    const { ctx, organizationId, connectionId, runPull } = await setup()
    pull = async () => {
      throw new CursorExpiredError('nothing at all')
    }
    await expect(runPull()).rejects.toBeInstanceOf(PermanentJobError)
    expect(calls).toBe(1)
    expect(await ctx.db.syncState.findFirstOrThrow({ where: { connectionId, stream: 'orders_pull' } })).toMatchObject({
      lastErrorKind: 'permanent',
      cursor: null,
    })

    await ctx.db.syncState.updateMany({ where: { connectionId, stream: 'orders_pull' }, data: { cursor: 'e1:old' } })
    calls = 0
    await expect(runPull()).rejects.toBeInstanceOf(PermanentJobError)
    expect(calls).toBe(2)
    expect(await ctx.db.eventLog.count({ where: { organizationId, type: 'connection.order_feed_restarted' } })).toBe(1)
    expect((await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId } })).health).toBe('failing')
  })

  it('applies Order updates to Orders it has and ignores the others without failing the page', async () => {
    const { ctx, organizationId, connectionId, runPull } = await setup()
    await importOrder(ctx, organizationId, connectionId, buildOrder({ externalId: 'known' }))
    pull = async () => ({
      items: [
        { kind: 'update', externalId: 'unknown', facts: [fact('unknown:removed', 'cancelled')] },
        { kind: 'update', externalId: 'known', facts: [fact('known:shipped', 'shipped')] },
        buildOrder({ externalId: 'new-one' }),
      ],
      nextCursor: '1',
      hasMore: false,
    })
    await runPull()

    expect(await ctx.db.order.findFirstOrThrow({ where: { connectionId, externalId: 'known' } })).toMatchObject({ phase: 'shipped' })
    expect(await ctx.db.order.count({ where: { connectionId, externalId: 'unknown' } })).toBe(0)
    const sync = await ctx.db.syncState.findFirstOrThrow({ where: { connectionId, stream: 'orders_pull' } })
    expect(sync).toMatchObject({ cursor: '1', lastResult: { pulled: 3, imported: 1, factsApplied: 1, pages: 1, updatesIgnored: 1 } })
  })

  it('a payload naming another organization does nothing', async () => {
    const { ctx, connectionId } = await setup()
    const other = await createTestOrganization(ctx.db)
    pull = async () => ({ items: [buildOrder()], nextCursor: '1', hasMore: false })
    await ordersPullJob.handler(ctx, { organizationId: other, connectionId, trigger: 'manual' }, run)
    expect(calls).toBe(0)
    expect(await ctx.db.order.count({ where: { connectionId } })).toBe(0)
    expect(await ctx.db.syncState.count({ where: { connectionId } })).toBe(0)
    expect((await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId } })).health).toBe('unknown')
  })
})
