import { defineConnector, type Order, type PullResult } from '@hanza/connector-sdk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createConnection } from '../connections/connections'
import { saveSyncCursor } from '../connections/sync-state'
import { PermanentJobError, type JobRunInfo } from '../jobs'
import { ordersPullJob } from '../jobs/orders-pull'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, user } from '../testing/fixtures'

type Pull = (cursor: string | null) => Promise<PullResult<Order>>
let pull: Pull = async () => ({ items: [], nextCursor: null, hasMore: false })

const channel = defineConnector({
  id: 'guard-channel',
  name: 'Guard channel',
  kind: 'marketplace',
  auth: { type: 'apiKey' },
  configSchema: z.object({}),
  credentialsSchema: z.object({ apiKey: z.string().min(1) }),
  capabilities: {
    async 'offers.pull'() {
      return { items: [], nextCursor: null, hasMore: false }
    },
    async 'orders.pull'(_ctx, cursor) {
      return pull(cursor)
    },
    async 'stock.push'() {},
  },
})

const attempt = (n: number): JobRunInfo => ({ attempt: n, maxAttempts: 5, retriedLater: 0 })

describe.skipIf(!databaseUrl)('failures outside connector calls are recorded in sync state', () => {
  const context = useTestContext({ connectors: [channel] })

  // A database failure inside importOrder that no validation can foresee. Only Orders whose
  // external id starts with "reject-" are affected, so other test files sharing the database are not.
  beforeAll(async () => {
    const { db } = context()
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION hanza_test_reject_order() RETURNS trigger AS $$
      BEGIN
        IF NEW."externalId" LIKE 'reject-%' THEN RAISE EXCEPTION 'order rejected by the test trigger'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`)
    await db.$executeRawUnsafe(
      'CREATE OR REPLACE TRIGGER hanza_test_reject_order BEFORE INSERT ON "order" FOR EACH ROW EXECUTE FUNCTION hanza_test_reject_order()',
    )
  })

  afterAll(async () => {
    const { db } = context()
    await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS hanza_test_reject_order ON "order"')
    await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS hanza_test_reject_order()')
  })

  async function setup() {
    const ctx = context()
    const organizationId = await createTestOrganization(ctx.db)
    const { connectionId } = await createConnection(
      ctx,
      organizationId,
      { connectorId: 'guard-channel', name: 'Kanał', config: {}, credentials: { apiKey: 'k' } },
      user,
    )
    const runPull = (run: JobRunInfo) => ordersPullJob.handler(ctx, { organizationId, connectionId, trigger: 'schedule' }, run)
    const state = async () => ({
      health: (await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId } })).health,
      sync: await ctx.db.syncState.findFirst({ where: { connectionId, stream: 'orders_pull' } }),
    })
    return { ctx, organizationId, connectionId, runPull, state }
  }

  it('a database error while importing: transient, failing on the last attempt, cursor kept, no later Order skipped', async () => {
    const { ctx, organizationId, connectionId, runPull, state } = await setup()
    await saveSyncCursor(ctx, organizationId, connectionId, 'orders_pull', '3')
    const rejected = buildOrder({ externalId: 'reject-1' })
    const good = buildOrder({ externalId: 'after-reject-1' })
    pull = async () => ({ items: [rejected, good], nextCursor: '5', hasMore: false })

    await expect(runPull(attempt(1))).rejects.not.toBeInstanceOf(PermanentJobError)
    const first = await state()
    expect(first.health).toBe('unknown')
    expect(first.sync).toMatchObject({ cursor: '3', lastErrorKind: 'transient', lastSucceededAt: null })
    expect(first.sync?.lastError).toContain('order rejected by the test trigger')
    expect(first.sync?.lastError).not.toMatch(/Jan Testowy|jan\.testowy|Przykładowa/)

    await expect(runPull(attempt(5))).rejects.toThrow()
    expect(await state()).toMatchObject({ health: 'failing', sync: { cursor: '3', lastErrorKind: 'transient' } })
    expect(await ctx.db.order.count({ where: { organizationId } })).toBe(0)

    // Once the cause is gone, the same page imports both Orders.
    pull = async () => ({ items: [{ ...rejected, externalId: 'fixed-1' }, good], nextCursor: '5', hasMore: false })
    await runPull(attempt(1))
    expect(await state()).toMatchObject({ health: 'ok', sync: { cursor: '5', lastErrorKind: null } })
    expect(await ctx.db.order.count({ where: { organizationId } })).toBe(2)
  })

  it('credentials that no longer decrypt: recorded as transient, failing on the last attempt', async () => {
    const { ctx, connectionId, runPull, state } = await setup()
    await ctx.db.connection.update({ where: { id: connectionId }, data: { credentials: 'v1:AAAA:AAAA:AAAA' } })
    pull = async () => {
      throw new Error('must not be called')
    }
    await expect(runPull(attempt(1))).rejects.toThrow()
    expect(await state()).toMatchObject({ health: 'unknown', sync: { lastErrorKind: 'transient' } })
    await expect(runPull(attempt(5))).rejects.toThrow()
    const { health, sync } = await state()
    expect(health).toBe('failing')
    expect(sync?.lastError).toMatch(/sealed value/i)
  })
})
