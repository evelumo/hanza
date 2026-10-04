import {
  AuthExpiredError,
  defineConnector,
  errorFromResponse,
  PermanentError,
  RateLimitedError,
  TransientError,
  type Order,
  type PullResult,
} from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createConnection } from '../connections/connections'
import { saveSyncCursor } from '../connections/sync-state'
import { PermanentJobError, RetryLaterError, type JobRunInfo } from '../jobs'
import { ordersPullJob } from '../jobs/orders-pull'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, user } from '../testing/fixtures'

type Pull = (cursor: string | null) => Promise<PullResult<Order>>
let pull: Pull = async () => ({ items: [], nextCursor: null, hasMore: false })

const testChannel = defineConnector({
  id: 'engine-test',
  name: 'Engine test',
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

const firstAttempt: JobRunInfo = { attempt: 1, maxAttempts: 5, retriedLater: 0 }
const lastAttempt: JobRunInfo = { attempt: 5, maxAttempts: 5, retriedLater: 0 }

describe.skipIf(!databaseUrl)('runConnectorCall (through orders.pull)', () => {
  const context = useTestContext({ connectors: [testChannel] })

  async function setup(credentials: Record<string, unknown> = { apiKey: 'secret-key' }) {
    const ctx = context()
    const organizationId = await createTestOrganization(ctx.db)
    const { connectionId } = await createConnection(
      ctx,
      organizationId,
      { connectorId: 'engine-test', name: 'Test', config: {}, credentials },
      user,
    )
    const runPull = (run: JobRunInfo = firstAttempt) =>
      ordersPullJob.handler(ctx, { organizationId, connectionId, trigger: 'schedule' }, run)
    const state = async () => {
      const connection = await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId } })
      const sync = await ctx.db.syncState.findFirst({ where: { connectionId, stream: 'orders_pull' } })
      return { health: connection.health, sync }
    }
    return { ctx, organizationId, connectionId, runPull, state }
  }

  const failWith = (error: unknown): Pull => async () => {
    throw error
  }

  it('success: done, health ok, results recorded', async () => {
    const { runPull, state } = await setup()
    pull = async () => ({ items: [buildOrder()], nextCursor: '1', hasMore: false })
    await runPull()
    const { health, sync } = await state()
    expect(health).toBe('ok')
    expect(sync).toMatchObject({ cursor: '1', lastResult: { pulled: 1, imported: 1, factsApplied: 0, pages: 1 }, lastErrorKind: null })
  })

  it('auth_expired: no retry, health auth_expired', async () => {
    const { runPull, state } = await setup()
    pull = failWith(new AuthExpiredError('401 Unauthorized'))
    await expect(runPull()).rejects.toBeInstanceOf(PermanentJobError)
    const { health, sync } = await state()
    expect(health).toBe('auth_expired')
    expect(sync).toMatchObject({ lastErrorKind: 'auth_expired', lastError: '401 Unauthorized', lastSucceededAt: null })
  })

  it('rate_limited: retry later without an attempt, health unchanged', async () => {
    const { runPull, state } = await setup()
    pull = failWith(new RateLimitedError('429 Too Many Requests', { retryAfterMs: 5_000 }))
    const error = await runPull().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RetryLaterError)
    expect((error as RetryLaterError).delayMs).toBe(5_000)
    const { health, sync } = await state()
    expect(health).toBe('unknown')
    expect(sync).toMatchObject({ lastErrorKind: 'rate_limited', lastError: '429 Too Many Requests' })
  })

  it('rate_limited: the delay is clamped to between 1 s and 15 minutes', async () => {
    const { runPull } = await setup()
    const delayFor = async (error: unknown) => {
      pull = failWith(error)
      return ((await runPull().catch((caught: unknown) => caught)) as RetryLaterError).delayMs
    }
    expect(await delayFor(new RateLimitedError('slow down', { retryAfterMs: 0 }))).toBe(1_000)
    const pastDate = new Response(null, { status: 429, headers: { 'Retry-After': 'Wed, 01 Jan 2025 00:00:00 GMT' } })
    expect(await delayFor(await errorFromResponse(pastDate))).toBe(1_000)
    const zero = new Response(null, { status: 429, headers: { 'Retry-After': '0' } })
    expect(await delayFor(await errorFromResponse(zero))).toBe(1_000)
    expect(await delayFor(new RateLimitedError('slow down', { retryAfterMs: 3_600_000 }))).toBe(900_000)
  })

  it('rate_limited: after 10 rate-limit retries of an attempt, the next one uses the attempt like a transient error', async () => {
    const { runPull, state } = await setup()
    const limited = new RateLimitedError('429 Too Many Requests', { retryAfterMs: 5_000 })
    pull = failWith(limited)
    await expect(runPull({ ...firstAttempt, retriedLater: 9 })).rejects.toBeInstanceOf(RetryLaterError)
    await expect(runPull({ ...firstAttempt, retriedLater: 10 })).rejects.toBe(limited)
    expect(await state()).toMatchObject({ health: 'unknown', sync: { lastErrorKind: 'transient', lastError: '429 Too Many Requests' } })
    await expect(runPull({ ...lastAttempt, retriedLater: 10 })).rejects.toBe(limited)
    expect((await state()).health).toBe('failing')
  })

  it('transient: rethrown for a normal retry; health turns failing only on the last attempt', async () => {
    const { runPull, state } = await setup()
    const transient = new TransientError('503 Service Unavailable')
    pull = failWith(transient)
    await expect(runPull(firstAttempt)).rejects.toBe(transient)
    expect(await state()).toMatchObject({ health: 'unknown', sync: { lastErrorKind: 'transient' } })
    await expect(runPull(lastAttempt)).rejects.toBe(transient)
    expect((await state()).health).toBe('failing')
  })

  it('an unknown error counts as transient', async () => {
    const { runPull, state } = await setup()
    pull = failWith(new Error('socket hang up'))
    await expect(runPull()).rejects.toThrow('socket hang up')
    expect(await state()).toMatchObject({ health: 'unknown', sync: { lastErrorKind: 'transient', lastError: 'socket hang up' } })
  })

  it('permanent: no retry, health failing', async () => {
    const { runPull, state } = await setup()
    pull = failWith(new PermanentError('400 Bad Request'))
    await expect(runPull()).rejects.toBeInstanceOf(PermanentJobError)
    expect(await state()).toMatchObject({ health: 'failing', sync: { lastErrorKind: 'permanent' } })
  })

  it('an Order that breaks the canonical schema is permanent and the cursor does not advance', async () => {
    const { ctx, organizationId, connectionId, runPull, state } = await setup()
    await saveSyncCursor(ctx, organizationId, connectionId, 'orders_pull', '3')
    const broken = { ...buildOrder(), total: { amount: 79.98, currency: 'PLN' } } as unknown as Order
    pull = async (cursor) => {
      expect(cursor).toBe('3')
      return { items: [broken], nextCursor: '4', hasMore: false }
    }
    await expect(runPull()).rejects.toBeInstanceOf(PermanentJobError)
    expect(await state()).toMatchObject({ health: 'failing', sync: { cursor: '3', lastErrorKind: 'permanent' } })
    expect(await ctx.db.order.count({ where: { organizationId } })).toBe(0)
  })

  it('stored credentials that no longer match the connector fail the run as permanent, naming only the field', async () => {
    const { runPull, state } = await setup({ apiKey: '' })
    pull = async () => {
      throw new Error('must not be called')
    }
    await expect(runPull()).rejects.toBeInstanceOf(PermanentJobError)
    const { health, sync } = await state()
    expect(health).toBe('failing')
    expect(sync?.lastError).toContain('credentials.apiKey')
  })

  it('a later success brings the Connection back to ok', async () => {
    const { runPull, state } = await setup()
    pull = failWith(new AuthExpiredError('401 Unauthorized'))
    await expect(runPull()).rejects.toBeInstanceOf(PermanentJobError)
    pull = async () => ({ items: [], nextCursor: null, hasMore: false })
    await runPull()
    expect((await state()).health).toBe('ok')
  })
})
