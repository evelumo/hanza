import { createFakeOAuthChannel, type FakeOAuthChannel, type FakeOAuthCredentials } from '@hanza/connector-fake'
import {
  createConnection,
  createProduct,
  jobs,
  openConnection,
  ordersPullJob,
  PermanentJobError,
  requestSync,
  stockPushJob,
  syncTickRef,
  type Actor,
  type JobRunInfo,
} from '@hanza/core'
import { createTestContext, createTestOrganization, type TestContext } from '@hanza/core/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'

const databaseUrl = inject('hanzaTestDatabaseUrl')
const user: Actor = { type: 'user', userId: 'user-1' }
const run: JobRunInfo = { attempt: 1, maxAttempts: 5, retriedLater: 0 }
const settings = { HANZA_CONNECTOR_FAKE_OAUTH_CLIENT_ID: 'test-client', HANZA_CONNECTOR_FAKE_OAUTH_CLIENT_SECRET: 'test-secret' }

describe.skipIf(!databaseUrl)('OAuth token refresh end to end (real Postgres, in-memory queue, fake OAuth Channel)', () => {
  let ctx: TestContext
  let fake: FakeOAuthChannel
  let org: string

  beforeAll(async () => {
    fake = createFakeOAuthChannel()
    ctx = createTestContext({ databaseUrl: databaseUrl!, connectors: [fake.connector], connectorSettings: settings })
  })

  // Each test gets its own organization: `fake.reset()` invalidates every token issued before, which would fail
  // the stock pushes an earlier test's Connections get when this test's Orders reserve the shared Product.
  beforeEach(async () => {
    fake.reset()
    ctx.queue.waiting.length = 0
    org = await createTestOrganization(ctx.db)
    await createProduct(ctx, org, { sku: 'FAKE-SKU-1', name: 'Mug', stock: 5 }, user)
  })

  afterAll(async () => {
    await ctx?.db.$disconnect()
  })

  /** A Connection whose credentials expire in `lifetimeMs`, as if just signed in; later tokens live an hour. */
  async function signedIn(name: string, lifetimeMs = 3_600_000) {
    fake.options.accessTokenLifetimeMs = lifetimeMs
    const credentials = fake.issueCredentials()
    fake.options.accessTokenLifetimeMs = 3_600_000
    const { connectionId } = await createConnection(ctx, org, { connectorId: 'fake-oauth', name, config: {}, credentials }, user)
    return { connectionId, credentials }
  }

  async function stored(connectionId: string) {
    const opened = await openConnection(ctx, org, connectionId)
    return { credentials: opened!.credentials as FakeOAuthCredentials, version: opened!.credentialsVersion, health: opened!.health }
  }

  /** The index of the first token use after the rotation that replaced `token`. */
  function usedAfterRotation(token: string): string[] {
    const rotatedAt = fake.tokenUses.findIndex((use) => use.accessToken !== token)
    return rotatedAt === -1 ? [] : fake.tokenUses.slice(rotatedAt).map((use) => use.accessToken)
  }

  /** Only this organization's jobs: the tick reads every Connection in the shared test database. */
  function keepOwnJobs() {
    const own = ctx.queue.waiting.filter((job) => (job.payload as { organizationId?: string }).organizationId === org)
    ctx.queue.waiting.splice(0, ctx.queue.waiting.length, ...own)
  }

  it('refreshes before expiry: the first run rotates the pair before any call, and the old token is never used', async () => {
    const { connectionId, credentials } = await signedIn('Expiring soon', 5 * 60_000)
    await requestSync(ctx, org, connectionId)
    const result = await ctx.queue.drain(ctx, jobs)
    expect(result.failed).toEqual([])

    expect(fake.refreshes).toEqual([{ refreshToken: credentials.refreshToken, outcome: 'rotated' }])
    const now = await stored(connectionId)
    expect(now).toMatchObject({ version: 1, health: 'ok' })
    expect(now.credentials.refreshToken).not.toBe(credentials.refreshToken)
    expect(fake.tokenUses.length).toBeGreaterThan(0)
    expect(fake.tokenUses.map((use) => use.accessToken)).not.toContain(credentials.accessToken)
    expect(fake.tokenUses.every((use) => use.accepted && use.accessToken === now.credentials.accessToken)).toBe(true)
    const raw = await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId, organizationId: org } })
    expect(raw.credentialsExpireAt?.toISOString()).toBe(now.credentials.accessTokenExpiresAt)
  })

  it('refreshes on a 401 and retries the call once, with the new token', async () => {
    const { connectionId, credentials } = await signedIn('Dropped token')
    fake.expireAccessTokens()
    await ordersPullJob.handler(ctx, { organizationId: org, connectionId, trigger: 'manual' }, run)

    const now = await stored(connectionId)
    expect(fake.refreshes.map((entry) => entry.outcome)).toEqual(['rotated'])
    expect(fake.tokenUses.map((use) => [use.capability, use.accessToken, use.accepted])).toEqual([
      ['orders.pull', credentials.accessToken, false],
      ['orders.pull', now.credentials.accessToken, true],
      ['orders.pull', now.credentials.accessToken, true],
      ['orders.pull', now.credentials.accessToken, true],
    ])
    expect(now).toMatchObject({ version: 1, health: 'ok' })
    expect(usedAfterRotation(credentials.accessToken)).not.toContain(credentials.accessToken)
  })

  it('two jobs refreshing at once make one refresh, and both use the new token', async () => {
    const { connectionId, credentials } = await signedIn('Concurrent', 60_000)
    fake.options.refreshDelayMs = 300
    await Promise.all([
      ordersPullJob.handler(ctx, { organizationId: org, connectionId, trigger: 'manual' }, run),
      stockPushJob.handler(ctx, { organizationId: org, connectionId }, run),
    ])

    expect(fake.refreshes).toEqual([{ refreshToken: credentials.refreshToken, outcome: 'rotated' }])
    const now = await stored(connectionId)
    expect(now.version).toBe(1)
    const used = new Set(fake.tokenUses.map((use) => use.accessToken))
    expect([...used]).toEqual([now.credentials.accessToken])
    expect(fake.tokenUses.every((use) => use.accepted)).toBe(true)
  })

  it('a refused refresh marks the Connection auth_expired once: no retries, and the tick leaves it alone', async () => {
    const { connectionId, credentials } = await signedIn('Revoked')
    fake.revokeAll()
    await requestSync(ctx, org, connectionId)
    const queued = ctx.queue.waiting.length
    const result = await ctx.queue.drain(ctx, jobs)

    expect(result.failed.length).toBeGreaterThan(0)
    expect(result.failed.every((job) => job.attempts === 1 && job.error instanceof PermanentJobError)).toBe(true)
    // At most one refresh per job that was already queued, each refused once.
    expect(fake.refreshes.length).toBeLessThanOrEqual(queued)
    expect(fake.refreshes.every((entry) => entry.outcome === 'refused' && entry.refreshToken === credentials.refreshToken)).toBe(true)
    expect((await stored(connectionId)).health).toBe('auth_expired')
    const state = await ctx.db.syncState.findFirstOrThrow({ where: { organizationId: org, connectionId, stream: 'offers_pull' } })
    expect(state).toMatchObject({ lastErrorKind: 'auth_expired', lastError: '400 invalid_grant' })
    expect(JSON.stringify(await ctx.db.syncState.findMany({ where: { organizationId: org, connectionId } }))).not.toContain('fake-')
    const events = await ctx.db.eventLog.findMany({ where: { organizationId: org, subjectId: connectionId } })
    expect(JSON.stringify(events)).not.toContain('fake-refresh-')

    const refreshes = fake.refreshes.length
    await ctx.db.syncState.updateMany({ where: { organizationId: org, connectionId }, data: { lastStartedAt: new Date(0) } })
    await ctx.queue.enqueue(syncTickRef, {})
    await ctx.queue.drain(ctx, jobs, { maxJobs: 1 })
    keepOwnJobs()
    expect(ctx.queue.waiting.filter((job) => (job.payload as { connectionId?: string }).connectionId === connectionId)).toEqual([])
    await ctx.queue.drain(ctx, jobs)
    expect(fake.refreshes).toHaveLength(refreshes)
  })

  it('a refresh that fails for now is retried with backoff and never marks the Connection auth_expired', async () => {
    const { connectionId } = await signedIn('Flaky token endpoint')
    fake.expireAccessTokens()
    fake.options.refreshBehaviour = 'fail_transient'
    await ctx.queue.enqueue(
      { name: 'orders.pull', schema: ordersPullJob.schema },
      { organizationId: org, connectionId, trigger: 'manual' },
    )
    const result = await ctx.queue.drain(ctx, jobs)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]?.attempts).toBe(5)
    expect(fake.refreshes.map((entry) => entry.outcome)).toEqual(['failed', 'failed', 'failed', 'failed', 'failed'])
    expect((await stored(connectionId)).health).toBe('failing')

    fake.options.refreshBehaviour = 'rotate'
    await requestSync(ctx, org, connectionId)
    expect((await ctx.queue.drain(ctx, jobs)).failed).toEqual([])
    expect(await stored(connectionId)).toMatchObject({ health: 'ok', version: 1 })
  })
})
