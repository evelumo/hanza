import { defineConnector, type OrderStatus } from '@hanza/connector-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createConnection } from '../connections/connections'
import { failSyncRun } from '../connections/sync-state'
import type { JobRunInfo } from '../jobs'
import { importOrder } from '../orders/import'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, user } from '../testing/fixtures'
import { ordersUpdateStatusJob } from './orders-update-status'

const updates: Array<{ orderExternalId: string; status: OrderStatus }> = []
let sendsRequest = true

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
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

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
    await failSyncRun(ctx, organizationId, connectionId, 'order_status_push', { kind: 'auth_expired', message: '401', health: 'auth_expired' })
    const state = async () => ({
      health: (await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId } })).health,
      sync: await ctx.db.syncState.findFirst({ where: { connectionId, stream: 'order_status_push' } }),
    })
    return { ctx, organizationId, connectionId, orderId, state }
  }

  it('a push that reached the Channel records its result and brings the Connection back to ok', async () => {
    const { ctx, organizationId, orderId, state } = await setup()
    await ordersUpdateStatusJob.handler(ctx, { organizationId, orderId }, run)
    expect(updates).toEqual([{ orderExternalId: 'status-order-1', status: 'new' }])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await state()).toMatchObject({ health: 'ok', sync: { lastResult: { pushed: 1 }, lastErrorKind: null } })
  })

  it('a push resolved without a request records only that it finished and leaves auth_expired alone', async () => {
    const { ctx, organizationId, orderId, state } = await setup()
    sendsRequest = false
    await ordersUpdateStatusJob.handler(ctx, { organizationId, orderId }, run)
    expect(updates).toHaveLength(1)
    expect(fetchMock).not.toHaveBeenCalled()
    const { health, sync } = await state()
    expect(health).toBe('auth_expired')
    expect(sync).toMatchObject({ lastResult: null, lastSucceededAt: null, lastErrorKind: 'auth_expired', lastError: '401' })
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
