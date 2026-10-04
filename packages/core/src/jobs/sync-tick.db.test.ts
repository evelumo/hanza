import { defineConnector } from '@hanza/connector-sdk'
import type { SyncStream } from '@hanza/db'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createConnection } from '../connections/connections'
import { SYNC_INTERVALS_MS } from '../sync/schedule'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { user } from '../testing/fixtures'
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
  const context = useTestContext({ connectors: [channel, courier] })

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
    await syncTickJob.handler(ctx, {}, { attempt: 1, maxAttempts: 5 })
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
})
