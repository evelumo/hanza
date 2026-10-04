import { defineConnector, type Offer, type PullResult } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createConnection } from '../connections/connections'
import { PermanentJobError, type JobRunInfo } from '../jobs'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { user } from '../testing/fixtures'
import { offersPullJob } from './offers-pull'

type Pull = (cursor: string | null) => Promise<PullResult<Offer>>
let pull: Pull = async () => ({ items: [], nextCursor: null, hasMore: false })
let calls = 0

const channel = defineConnector({
  id: 'offers-pull-channel',
  name: 'Offers pull channel',
  kind: 'marketplace',
  auth: { type: 'none' },
  configSchema: z.object({}),
  credentialsSchema: z.object({}),
  capabilities: {
    async 'offers.pull'(_ctx, cursor) {
      calls++
      return pull(cursor)
    },
    async 'orders.pull'() {
      return { items: [], nextCursor: null, hasMore: false }
    },
    async 'stock.push'() {},
  },
})

const run = (attempt = 1): JobRunInfo => ({ attempt, maxAttempts: 5, retriedLater: 0 })

describe.skipIf(!databaseUrl)('offers.pull', () => {
  const context = useTestContext({ connectors: [channel] })

  async function setup() {
    const ctx = context()
    const organizationId = await createTestOrganization(ctx.db)
    const { connectionId } = await createConnection(
      ctx,
      organizationId,
      { connectorId: 'offers-pull-channel', name: 'Kanał', config: {}, credentials: {} },
      user,
    )
    const runPull = (info: JobRunInfo = run(), trigger: 'schedule' | 'manual' = 'schedule') =>
      offersPullJob.handler(ctx, { organizationId, connectionId, trigger }, info)
    const state = async () => ({
      health: (await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId } })).health,
      sync: await ctx.db.syncState.findFirst({ where: { connectionId, stream: 'offers_pull' } }),
    })
    calls = 0
    return { ctx, organizationId, connectionId, runPull, state }
  }

  const offer = (externalId: string, sku: string | null = null): Offer => ({ externalId, sku, name: externalId, url: null })

  it.each([
    ['null', null],
    ['unchanged', 'p1'],
  ])('hasMore with a %s nextCursor breaks the paging contract: permanent, no endless loop', async (_label, nextCursor) => {
    const { runPull, state } = await setup()
    pull = async (cursor) =>
      cursor === null ? { items: [offer('o1')], nextCursor: 'p1', hasMore: true } : { items: [offer('o2')], nextCursor, hasMore: true }
    await expect(runPull()).rejects.toBeInstanceOf(PermanentJobError)
    expect(calls).toBe(2)
    const { health, sync } = await state()
    expect(health).toBe('failing')
    expect(sync).toMatchObject({ lastErrorKind: 'permanent', lastSucceededAt: null })
    expect(sync?.lastError).toContain('paging contract')
  })

  it('a payload naming another organization does nothing', async () => {
    const { ctx, connectionId, state } = await setup()
    const other = await createTestOrganization(ctx.db)
    pull = async () => ({ items: [offer('o1')], nextCursor: '1', hasMore: false })
    await offersPullJob.handler(ctx, { organizationId: other, connectionId, trigger: 'manual' }, run())
    expect(calls).toBe(0)
    expect(await ctx.db.offer.count({ where: { connectionId } })).toBe(0)
    expect(await ctx.db.syncState.count({ where: { connectionId } })).toBe(0)
    expect((await state()).health).toBe('unknown')
    expect(ctx.queue.waiting.filter((job) => (job.payload as { connectionId: string }).connectionId === connectionId)).toEqual([])
  })
})
