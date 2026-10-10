import { defineConnector } from '@hanza/connector-sdk'
import type { SyncStream } from '@hanza/db'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createConnection } from '../connections/connections'
import type { Context } from '../context'
import { changeOrderStatus } from '../orders/change-status'
import { importOrder } from '../orders/import'
import { STATUS_PUSH_RETRY_MS } from '../orders/status-push'
import { requestShipment } from '../shipments/request'
import { SHIPMENT_RETRY_MS } from '../shipments/schedule'
import { SYNC_INTERVALS_MS } from '../sync/schedule'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { createTestCarrier } from '../testing/carrier'
import { buildOrder, jobRun, lockerShipment, secondsUntilDue, user } from '../testing/fixtures'
import { shipmentsCreateJob } from './shipments-create'
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

const carrier = createTestCarrier({ id: 'tick-carrier' })

// A Channel with shipping of its own: the tick goes by capabilities, not by kind.
const shippingChannel = defineConnector({
  ...channel,
  id: 'tick-shipping-channel',
  shipping: carrier.connector.shipping,
  capabilities: { ...channel.capabilities, ...carrier.connector.capabilities },
})

describe.skipIf(!databaseUrl)('sync.tick', () => {
  const context = useTestContext({ connectors: [channel, statusChannel, pricedChannel, courier, carrier.connector, shippingChannel] })

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

  it('enqueues the workflow sweep, coalesced', async () => {
    const ctx = context()
    await syncTickJob.handler(ctx, {}, { attempt: 1, maxAttempts: 5, retriedLater: 0 })
    await syncTickJob.handler(ctx, {}, { attempt: 1, maxAttempts: 5, retriedLater: 0 })
    const sweeps = ctx.queue.waiting.filter((job) => job.name === 'workflow.sweep')
    expect(sweeps).toEqual([{ name: 'workflow.sweep', payload: {}, options: { coalesceKey: 'workflow.sweep' } }])
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

  describe('sweep of Shipments', () => {
    /** A requested Shipment through `connectorId` whose immediate job was lost with the queue. */
    async function lostRequest(connectorId = 'tick-carrier') {
      const ctx = context()
      const org = await createTestOrganization(ctx.db)
      const channelId = await connection(org, 'tick-channel')
      const carrierId = await connection(org, connectorId)
      const { orderId } = await importOrder(ctx, org, channelId, buildOrder())
      const queueDown: Context = {
        ...ctx,
        queue: {
          ...ctx.queue,
          enqueue: async () => {
            throw new Error('Redis unavailable')
          },
        },
      }
      const request = async () => (await requestShipment(queueDown, org, orderId, lockerShipment(carrierId), user)).shipmentId
      const shipmentId = await request()
      return { ctx, org, channelId, carrierId, orderId, shipmentId, request }
    }

    async function shipmentJobs(connectionIds: string[], shipmentIds: string[]) {
      const ctx = context()
      const before = ctx.queue.enqueued.length
      await syncTickJob.handler(ctx, {}, jobRun)
      return ctx.queue.enqueued.slice(before).filter((job) => {
        const payload = job.payload as { connectionId?: string; shipmentId?: string }
        return job.name.startsWith('shipments.') && (connectionIds.includes(payload.connectionId ?? '') || shipmentIds.includes(payload.shipmentId ?? ''))
      })
    }

    const dueIn = (shipmentId: string) => secondsUntilDue(context(), shipmentId)

    it('recovers a create whose enqueue was lost, once per retry interval, and the job it enqueues asks the Carrier', async () => {
      const { ctx, org, carrierId, shipmentId } = await lostRequest()
      expect(ctx.queue.enqueued.filter((job) => (job.payload as { shipmentId?: string }).shipmentId === shipmentId)).toEqual([])

      expect(await shipmentJobs([carrierId], [shipmentId])).toEqual([
        { name: 'shipments.create', payload: { organizationId: org, shipmentId }, options: { coalesceKey: `shipments.create:${shipmentId}` } },
      ])
      expect(await dueIn(shipmentId)).toBeGreaterThan(SHIPMENT_RETRY_MS / 1000 - 60)
      expect(await shipmentJobs([carrierId], [shipmentId])).toEqual([])

      await shipmentsCreateJob.handler(ctx, { organizationId: org, shipmentId }, jobRun)
      expect(await ctx.db.shipment.findFirstOrThrow({ where: { id: shipmentId } })).toMatchObject({ status: 'pending' })
      expect(carrier.byReference(shipmentId)).toBeDefined()
    })

    it('enqueues one shipments.track per Connection while a Shipment at the Carrier is due, and none otherwise', async () => {
      const { ctx, org, carrierId, shipmentId, request } = await lostRequest()
      const second = await request()
      for (const id of [shipmentId, second]) await shipmentsCreateJob.handler(ctx, { organizationId: org, shipmentId: id }, jobRun)
      const track = { name: 'shipments.track', payload: { organizationId: org, connectionId: carrierId }, options: { coalesceKey: `shipments.track:${carrierId}` } }

      // Just created: due at the next tick, not this one.
      expect(await shipmentJobs([carrierId], [shipmentId, second])).toEqual([])
      await ctx.db.$executeRaw`UPDATE "shipment" SET "nextCheckAt" = now() - interval '1 second' WHERE "id" IN (${shipmentId}, ${second})`
      ctx.queue.waiting.length = 0
      expect(await shipmentJobs([carrierId], [shipmentId, second])).toEqual([track])
      // The job claims its Shipments, not the tick: they stay due until it runs.
      expect(await dueIn(shipmentId)).toBeLessThan(0)

      await ctx.db.shipment.updateMany({ where: { id: { in: [shipmentId, second] } }, data: { status: 'delivered', nextCheckAt: null } })
      ctx.queue.waiting.length = 0
      expect(await shipmentJobs([carrierId], [shipmentId, second])).toEqual([])
    })

    it('skips a Connection waiting for sign-in, and probes a failing one with a single create per tick', async () => {
      const waiting = await lostRequest()
      await waiting.ctx.db.connection.update({ where: { id: waiting.carrierId }, data: { health: 'auth_expired' } })
      expect(await shipmentJobs([waiting.carrierId], [waiting.shipmentId])).toEqual([])
      expect(await dueIn(waiting.shipmentId)).toBeLessThanOrEqual(0)

      const failing = await lostRequest()
      const others = [await failing.request(), await failing.request()]
      await failing.ctx.db.connection.update({ where: { id: failing.carrierId }, data: { health: 'failing' } })
      const all = [failing.shipmentId, ...others]
      expect(await shipmentJobs([failing.carrierId], all)).toHaveLength(1)
      expect(await shipmentJobs([failing.carrierId], all)).toHaveLength(1)
      await failing.ctx.db.connection.update({ where: { id: failing.carrierId }, data: { health: 'ok' } })
      expect(await shipmentJobs([failing.carrierId], all)).toHaveLength(1)
      expect(await shipmentJobs([failing.carrierId], all)).toEqual([])
    })

    it('goes by capabilities, not kind: a Channel with shipments.track gets its streams and its Shipments swept', async () => {
      const { org, carrierId, shipmentId } = await lostRequest('tick-shipping-channel')
      const jobs = await tick([carrierId])
      expect(jobs.map((job) => job.name)).toEqual(['offers.pull', 'orders.pull', 'stock.push'])
      // The create is keyed by the Shipment, so `tick` (which filters by Connection) does not show it.
      const ctx = context()
      expect(ctx.queue.enqueued.filter((job) => (job.payload as { shipmentId?: string }).shipmentId === shipmentId)).toEqual([
        { name: 'shipments.create', payload: { organizationId: org, shipmentId }, options: { coalesceKey: `shipments.create:${shipmentId}` } },
      ])
    })

    it('leaves a courier without shipments.track alone', async () => {
      const ctx = context()
      const org = await createTestOrganization(ctx.db)
      const id = await connection(org, 'tick-courier')
      expect(await tick([id])).toEqual([])
    })
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
