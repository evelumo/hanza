import { defineConnector, TransientError, type Offer, type PullResult } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createProduct } from '../catalog/products'
import { createConnection } from '../connections/connections'
import { PermanentJobError, type JobRunInfo } from '../jobs'
import { importOrder } from '../orders/import'
import { getAvailability } from '../stock/availability'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, orderLine, uniqueSku, user } from '../testing/fixtures'
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

  it('a retry still rematches the line waiting for an Offer that the failed attempt linked', async () => {
    const { ctx, organizationId, connectionId, runPull, state } = await setup()
    const sku = uniqueSku()
    const { productId } = await createProduct(ctx, organizationId, { sku, name: 'A', stock: 5 }, user)
    const { orderId } = await importOrder(
      ctx,
      organizationId,
      connectionId,
      buildOrder({ lines: [orderLine('l1', { offerExternalId: 'o1', quantity: 2 })] }),
    )
    let failed = false
    pull = async (cursor) => {
      if (cursor === null) return { items: [offer('o1', sku)], nextCursor: 'p1', hasMore: true }
      if (!failed) {
        failed = true
        throw new TransientError('503 Service Unavailable')
      }
      return { items: [offer('o2')], nextCursor: 'p2', hasMore: false }
    }
    // Page 1 links o1 and commits; page 2 fails, so the attempt ends before any rematch.
    await expect(runPull(run(1))).rejects.toBeInstanceOf(TransientError)
    // The retry sees o1 already linked (linked: 0) and must rematch anyway.
    await runPull(run(2))
    expect((await state()).sync?.lastResult).toMatchObject({ linked: 0 })
    const line = await ctx.db.orderLine.findFirstOrThrow({ where: { orderId }, include: { reservation: true } })
    expect(line.productId).toBe(productId)
    expect(line.reservation).toMatchObject({ status: 'open', units: 2 })
    expect((await getAvailability(ctx.db, organizationId, [productId])).get(productId)?.available).toBe(3)
  })

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

  it('stops after 50 pages and says so in the result and the log', async () => {
    const { ctx: base, organizationId, connectionId, state } = await setup()
    const errors: string[] = []
    const ctx = { ...base, log: { info() {}, error: (message: string) => void errors.push(message) } }
    pull = async (cursor) => {
      const page = cursor === null ? 0 : Number(cursor)
      return { items: [offer(`o${page}`)], nextCursor: String(page + 1), hasMore: true }
    }
    await offersPullJob.handler(ctx, { organizationId, connectionId, trigger: 'schedule' }, run())
    expect(calls).toBe(50)
    const { health, sync } = await state()
    expect(health).toBe('ok')
    expect(sync?.lastResult).toEqual({ seen: 50, created: 50, updated: 0, linked: 0, truncated: 1 })
    expect(errors).toEqual(['offers pull stopped at the page limit; later Offers were not read'])
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
