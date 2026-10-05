import { AuthExpiredError, defineConnector, PermanentError, TransientError, type OrderStatus } from '@hanza/connector-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createConnection } from '../connections/connections'
import { failSyncRun } from '../connections/sync-state'
import { PermanentJobError, type JobRunInfo } from '../jobs'
import { resolveAttention } from '../orders/attention'
import { changeOrderStatus } from '../orders/change-status'
import { importOrder } from '../orders/import'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, user } from '../testing/fixtures'
import { ordersUpdateStatusJob } from './orders-update-status'

const updates: Array<{ orderExternalId: string; status: OrderStatus }> = []
let sendsRequest = true
let failWith: Error | null = null
let duringPush: (() => Promise<void>) | null = null

const channel = defineConnector({
  id: 'status-channel',
  name: 'Status channel',
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
    async 'stock.push'() {},
    async 'orders.updateStatus'(ctx, input) {
      await duringPush?.()
      if (failWith) throw failWith
      updates.push(input)
      // Without a request: the Channel has no equivalent of this status.
      if (sendsRequest) await ctx.fetch('https://channel.example.com/status', { method: 'POST' })
    },
  },
})

const run: JobRunInfo = { attempt: 1, maxAttempts: 5, retriedLater: 0 }

describe.skipIf(!databaseUrl)('orders.updateStatus', () => {
  const context = useTestContext({ connectors: [channel] })
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockClear()
    updates.length = 0
    sendsRequest = true
    failWith = null
    duringPush = null
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** An Order a person moved to processing (so its push is pending), on a Connection waiting for sign-in. */
  async function setup() {
    const ctx = context()
    const organizationId = await createTestOrganization(ctx.db)
    const { connectionId } = await createConnection(
      ctx,
      organizationId,
      { connectorId: 'status-channel', name: 'Channel', config: {}, credentials: {} },
      user,
    )
    const { orderId } = await importOrder(ctx, organizationId, connectionId, buildOrder({ externalId: 'status-order-1' }))
    await changeOrderStatus(ctx, organizationId, orderId, 'processing', user)
    await failSyncRun(ctx, organizationId, connectionId, 'order_status_push', { kind: 'auth_expired', message: '401', health: 'auth_expired' })
    const state = async () => ({
      health: (await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId } })).health,
      sync: await ctx.db.syncState.findFirst({ where: { connectionId, stream: 'order_status_push' } }),
    })
    const order = () =>
      ctx.db.order.findFirstOrThrow({
        where: { id: orderId, organizationId },
        select: { status: true, statusPushSeq: true, statusPushDueAt: true, attentionReasons: true },
      })
    const push = () => ordersUpdateStatusJob.handler(ctx, { organizationId, orderId }, run)
    return { ctx, organizationId, connectionId, orderId, state, order, push }
  }

  it('a status change leaves a push pending, due after the grace period', async () => {
    const { order } = await setup()
    const { statusPushSeq, statusPushDueAt } = await order()
    expect(statusPushSeq).toBe(1)
    expect(statusPushDueAt!.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000)
  })

  it('a push that reached the Channel clears the pending push, records its result and brings the Connection back to ok', async () => {
    const { push, state, order } = await setup()
    await push()
    expect(updates).toEqual([{ orderExternalId: 'status-order-1', status: 'processing' }])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await state()).toMatchObject({ health: 'ok', sync: { lastResult: { pushed: 1 }, lastErrorKind: null } })
    expect((await order()).statusPushDueAt).toBeNull()
  })

  it('sends nothing when no push is pending', async () => {
    const { push } = await setup()
    await push()
    await push()
    expect(updates).toHaveLength(1)
  })

  it('a push resolved without a request clears the pending push but leaves auth_expired alone', async () => {
    const { push, state, order } = await setup()
    sendsRequest = false
    await push()
    expect(updates).toHaveLength(1)
    expect(fetchMock).not.toHaveBeenCalled()
    const { health, sync } = await state()
    expect(health).toBe('auth_expired')
    expect(sync).toMatchObject({ lastResult: null, lastSucceededAt: null, lastErrorKind: 'auth_expired', lastError: '401' })
    expect((await order()).statusPushDueAt).toBeNull()
  })

  it('a status changed during the push stays pending, and the next run sends it', async () => {
    const { ctx, organizationId, orderId, push, order } = await setup()
    duringPush = async () => {
      duringPush = null
      await changeOrderStatus(ctx, organizationId, orderId, 'cancelled', user)
    }
    await push()
    expect((await order()).statusPushDueAt).not.toBeNull()
    await push()
    expect(updates.map((update) => update.status)).toEqual(['processing', 'cancelled'])
    expect((await order()).statusPushDueAt).toBeNull()
  })

  it('a permanent refusal stops the push, marks the Order Needs attention and fails the job without retry', async () => {
    const { ctx, organizationId, orderId, push, order, state } = await setup()
    failWith = new PermanentError('Status not allowed')
    await expect(push()).rejects.toBeInstanceOf(PermanentJobError)
    expect(await order()).toMatchObject({ statusPushDueAt: null, attentionReasons: ['unmatched_line', 'status_push_failed'] })
    expect((await state()).sync).toMatchObject({ lastErrorKind: 'permanent', lastError: 'Status not allowed' })
    const raised = await ctx.db.eventLog.findMany({
      where: { organizationId, subjectId: orderId, type: 'order.attention_raised' },
      orderBy: { createdAt: 'asc' },
    })
    expect(raised.at(-1)?.payload).toEqual({ reasons: ['status_push_failed'] })
    await resolveAttention(ctx, organizationId, orderId, user)
    expect((await order()).attentionReasons).toEqual(['unmatched_line'])
  })

  it('a later status the Channel takes is pushed and clears the earlier refusal from Needs attention', async () => {
    const { ctx, organizationId, orderId, push, order } = await setup()
    failWith = new PermanentError('Status not allowed')
    await expect(push()).rejects.toBeInstanceOf(PermanentJobError)
    expect((await order()).attentionReasons).toEqual(['unmatched_line', 'status_push_failed'])

    failWith = null
    await changeOrderStatus(ctx, organizationId, orderId, 'cancelled', user)
    await push()
    expect(updates).toEqual([{ orderExternalId: 'status-order-1', status: 'cancelled' }])
    expect(await order()).toMatchObject({ statusPushDueAt: null, attentionReasons: ['unmatched_line'] })
  })

  it('a job enqueued before pending pushes were tracked (seq 0, nothing marked) still pushes the status', async () => {
    const ctx = context()
    const organizationId = await createTestOrganization(ctx.db)
    const { connectionId } = await createConnection(
      ctx,
      organizationId,
      { connectorId: 'status-channel', name: 'Channel', config: {}, credentials: {} },
      user,
    )
    const { orderId } = await importOrder(ctx, organizationId, connectionId, buildOrder({ externalId: 'legacy-order' }))
    await ctx.db.order.updateMany({ where: { id: orderId, organizationId }, data: { status: 'processing' } })
    expect(await ctx.db.order.findFirstOrThrow({ where: { id: orderId } })).toMatchObject({ statusPushSeq: 0, statusPushDueAt: null })

    await ordersUpdateStatusJob.handler(ctx, { organizationId, orderId }, run)
    expect(updates).toEqual([{ orderExternalId: 'legacy-order', status: 'processing' }])
  })

  it('a refusal of a status that has changed since leaves the newer push pending', async () => {
    const { ctx, organizationId, orderId, push, order } = await setup()
    failWith = new PermanentError('Status not allowed')
    duringPush = async () => {
      duringPush = null
      await changeOrderStatus(ctx, organizationId, orderId, 'new', user)
    }
    await expect(push()).rejects.toBeInstanceOf(PermanentJobError)
    expect(await order()).toMatchObject({ status: 'new', attentionReasons: ['unmatched_line'] })
    expect((await order()).statusPushDueAt).not.toBeNull()

    failWith = null
    await push()
    expect(updates).toEqual([{ orderExternalId: 'status-order-1', status: 'new' }])
  })

  it.each([
    ['auth_expired', () => new AuthExpiredError('401')],
    ['transient', () => new TransientError('503')],
  ])('%s keeps the push pending for a later run', async (_kind, error) => {
    const { push, order } = await setup()
    failWith = error()
    await expect(push()).rejects.toThrow()
    expect(await order()).toMatchObject({ attentionReasons: ['unmatched_line'] })
    expect((await order()).statusPushDueAt).not.toBeNull()
  })

  it("a payload naming another organization does nothing to the Order's Connection", async () => {
    const { ctx, connectionId, orderId } = await setup()
    const other = await createTestOrganization(ctx.db)
    const before = await ctx.db.syncState.findMany({ where: { connectionId }, orderBy: { stream: 'asc' } })
    await ordersUpdateStatusJob.handler(ctx, { organizationId: other, orderId }, run)
    expect(updates).toEqual([])
    expect(await ctx.db.syncState.findMany({ where: { connectionId }, orderBy: { stream: 'asc' } })).toEqual(before)
    expect((await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId } })).health).toBe('auth_expired')
  })
})
