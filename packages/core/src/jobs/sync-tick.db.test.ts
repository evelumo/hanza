import { defineConnector } from '@hanza/connector-sdk'
import type { SyncStream } from '@hanza/db'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createConnection } from '../connections/connections'
import { changeOrderStatus } from '../orders/change-status'
import { importOrder } from '../orders/import'
import { STATUS_PUSH_RETRY_MS } from '../orders/status-push'
import { SYNC_INTERVALS_MS } from '../sync/schedule'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, user } from '../testing/fixtures'
import { syncTickJob } from './sync-tick'

const channel = defineConnector({
  id: 'tick-channel',
  name: 'Tick channel',
  kind: 'shop',
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
    async 'stock.push'() {},
  },
})

const statusChannel = defineConnector({
  ...channel,
  id: 'tick-status-channel',
  capabilities: { ...channel.capabilities, async 'orders.updateStatus'() {} },
})

const pricedChannel = defineConnector({
  ...channel,
  id: 'tick-priced-channel',
  capabilities: { ...channel.capabilities, async 'price.push'() {} },
})

const courier = defineConnector({
  id: 'tick-courier',
  name: 'Tick courier',
  kind: 'courier',
  auth: { type: 'none' },
  configSchema: z.object({}),
  credentialsSchema: z.object({}),
  capabilities: {},
})

describe.skipIf(!databaseUrl)('sync.tick', () => {
  const context = useTestContext({ connectors: [channel, statusChannel, pricedChannel, courier] })

  async function connection(organizationId: string, connectorId: string) {
    const { connectionId } = await createConnection(context(), organizationId, { connectorId, name: connectorId, config: {}, credentials: {} }, user)
    return connectionId
  }

  async function started(organizationId: string, connectionId: string, stream: SyncStream, msAgo: number) {
    await context().db.syncState.create({
      data: { organizationId, connectionId, stream, lastStartedAt: new Date(Date.now() - msAgo) },
    })
  }

  async function tick(connectionIds: string[]) {
    const ctx = context()
    const before = ctx.queue.enqueued.length
    await syncTickJob.handler(ctx, {}, { attempt: 1, maxAttempts: 5, retriedLater: 0 })
    return ctx.queue.enqueued
      .slice(before)
      .filter((job) => connectionIds.includes((job.payload as { connectionId: string }).connectionId))
  }

  it('enqueues every stream of a Channel that never synced, with schedule trigger and coalesce keys', async () => {
    const org = await createTestOrganization(context().db)
    const id = await connection(org, 'tick-channel')
    expect(await tick([id])).toEqual([
      { name: 'offers.pull', payload: { organizationId: org, connectionId: id, trigger: 'schedule' }, options: { coalesceKey: `offers.pull:${id}` } },
      { name: 'orders.pull', payload: { organizationId: org, connectionId: id, trigger: 'schedule' }, options: { coalesceKey: `orders.pull:${id}` } },
      { name: 'stock.push', payload: { organizationId: org, connectionId: id }, options: { coalesceKey: `stock.push:${id}` } },
    ])
  })

  it('enqueues price.push only for a connector that implements it', async () => {
    const org = await createTestOrganization(context().db)
    const id = await connection(org, 'tick-priced-channel')
    const jobs = await tick([id])
    expect(jobs.map((job) => job.name)).toEqual(['offers.pull', 'orders.pull', 'stock.push', 'price.push'])
    expect(jobs.at(-1)).toEqual({ name: 'price.push', payload: { organizationId: org, connectionId: id }, options: { coalesceKey: `price.push:${id}` } })
  })

  it('enqueues only the streams whose interval has passed', async () => {
    const org = await createTestOrganization(context().db)
    const id = await connection(org, 'tick-channel')
    await started(org, id, 'offers_pull', SYNC_INTERVALS_MS.offers_pull - 60_000)
    await started(org, id, 'orders_pull', SYNC_INTERVALS_MS.orders_pull + 1_000)
    await started(org, id, 'stock_push', 30_000)
    expect((await tick([id])).map((job) => job.name)).toEqual(['orders.pull'])
  })

  it('skips Connections waiting for sign-in, non-Channel connectors and unregistered connectors', async () => {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const expired = await connection(org, 'tick-channel')
    await ctx.db.connection.update({ where: { id: expired }, data: { health: 'auth_expired' } })
    const failing = await connection(org, 'tick-channel')
    await ctx.db.connection.update({ where: { id: failing }, data: { health: 'failing' } })
    const notChannel = await connection(org, 'tick-courier')
    const unknown = await connection(org, 'no-longer-installed')

    const enqueued = await tick([expired, failing, notChannel, unknown])
    expect(new Set(enqueued.map((job) => (job.payload as { connectionId: string }).connectionId))).toEqual(new Set([failing]))
  })

  describe('sweep of pending Order status pushes', () => {
    /** An Order a person moved to processing on this Connection: its push is pending and its immediate job lost. */
    async function pendingOrder(organizationId: string, connectionId: string) {
      const ctx = context()
      const { orderId } = await importOrder(ctx, organizationId, connectionId, buildOrder())
      await changeOrderStatus(ctx, organizationId, orderId, 'processing', user)
      ctx.queue.waiting.length = 0
      return orderId
    }

    async function overdue(orderId: string) {
      await context().db.$executeRaw`UPDATE "order" SET "statusPushDueAt" = now() - interval '1 second' WHERE "id" = ${orderId}`
    }

    async function statusPushes(orderIds: string[]) {
      const ctx = context()
      const before = ctx.queue.enqueued.length
      await syncTickJob.handler(ctx, {}, { attempt: 1, maxAttempts: 5, retriedLater: 0 })
      return ctx.queue.enqueued
        .slice(before)
        .filter((job) => job.name === 'orders.updateStatus' && orderIds.includes((job.payload as { orderId: string }).orderId))
    }

    const dueAt = async (orderId: string) => (await context().db.order.findFirstOrThrow({ where: { id: orderId } })).statusPushDueAt

    it('enqueues only overdue pushes, with the per-Order coalesce key, and not again until the retry interval passed', async () => {
      const org = await createTestOrganization(context().db)
      const id = await connection(org, 'tick-status-channel')
      const late = await pendingOrder(org, id)
      const fresh = await pendingOrder(org, id)
      const { orderId: untouched } = await importOrder(context(), org, id, buildOrder())
      await overdue(late)

      expect(await statusPushes([late, fresh, untouched])).toEqual([
        { name: 'orders.updateStatus', payload: { organizationId: org, orderId: late }, options: { coalesceKey: `orders.updateStatus:${late}` } },
      ])
      expect((await dueAt(late))!.getTime()).toBeGreaterThan(Date.now() + STATUS_PUSH_RETRY_MS - 60_000)
      expect(await dueAt(untouched)).toBeNull()

      expect(await statusPushes([late, fresh, untouched])).toEqual([])
    })

    it('a failing Connection gets one push per tick, so a Channel that is down is probed, not flooded', async () => {
      const ctx = context()
      const org = await createTestOrganization(ctx.db)
      const id = await connection(org, 'tick-status-channel')
      const orders = [await pendingOrder(org, id), await pendingOrder(org, id), await pendingOrder(org, id), await pendingOrder(org, id)]
      for (const orderId of orders) await overdue(orderId)
      await ctx.db.connection.update({ where: { id }, data: { health: 'failing' } })

      expect(await statusPushes(orders)).toHaveLength(1)
      expect(await statusPushes(orders)).toHaveLength(1)
      await ctx.db.connection.update({ where: { id }, data: { health: 'ok' } })
      expect(await statusPushes(orders)).toHaveLength(2)
    })

    it('a status change on a connector without orders.updateStatus counts the change but leaves nothing to push', async () => {
      const ctx = context()
      const org = await createTestOrganization(ctx.db)
      const id = await connection(org, 'tick-channel')
      const { orderId } = await importOrder(ctx, org, id, buildOrder())
      const before = ctx.queue.enqueued.length
      await changeOrderStatus(ctx, org, orderId, 'processing', user)
      expect(await ctx.db.order.findFirstOrThrow({ where: { id: orderId } })).toMatchObject({ statusPushSeq: 1, statusPushDueAt: null })
      expect(ctx.queue.enqueued.slice(before).filter((job) => job.name === 'orders.updateStatus')).toEqual([])
    })

    it('skips Connections waiting for sign-in and connectors without orders.updateStatus', async () => {
      const ctx = context()
      const org = await createTestOrganization(ctx.db)
      const expired = await connection(org, 'tick-status-channel')
      const withoutCapability = await connection(org, 'tick-channel')
      const waiting = await pendingOrder(org, expired)
      const unsupported = await pendingOrder(org, withoutCapability)
      await ctx.db.connection.update({ where: { id: expired }, data: { health: 'auth_expired' } })
      await overdue(waiting)
      await overdue(unsupported)

      expect(await statusPushes([waiting, unsupported])).toEqual([])
      expect((await dueAt(waiting))!.getTime()).toBeLessThan(Date.now())
    })
  })
})
