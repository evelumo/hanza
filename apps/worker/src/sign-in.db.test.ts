import { createFakeOAuthChannel, FAKE_OAUTH_DEFAULT_ACCOUNT, type FakeOAuthChannel } from '@hanza/connector-fake'
import {
  addConnection,
  cancelSignIn,
  coalesceKeys,
  DomainError,
  getSignIn,
  jobs,
  requestSync,
  signInPollRef,
  SIGN_IN_KEEP_MS,
  SLOW_DOWN_STEP_SECONDS,
  startSignIn,
  sweepSignIns,
  syncTickRef,
  type Actor,
} from '@hanza/core'
import { createTestContext, createTestOrganization, type TestContext } from '@hanza/core/testing'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

const databaseUrl = inject('hanzaTestDatabaseUrl')
const user: Actor = { type: 'user', userId: 'user-1' }
const settings = {
  HANZA_CONNECTOR_FAKE_OAUTH_CLIENT_ID: 'test-client',
  HANZA_CONNECTOR_FAKE_OAUTH_CLIENT_SECRET: 'test-secret',
  HANZA_CONNECTOR_FAKE_OAUTH_POLL_INTERVAL_SECONDS: '2',
}

describe.skipIf(!databaseUrl)('sign-in through the device flow (real Postgres, in-memory queue, fake OAuth Channel)', () => {
  let ctx: TestContext
  let fake: FakeOAuthChannel
  let org: string
  let connectionId: string

  beforeAll(async () => {
    fake = createFakeOAuthChannel()
    ctx = createTestContext({ databaseUrl: databaseUrl!, connectors: [fake.connector], connectorSettings: settings })
    org = await createTestOrganization(ctx.db)
  })

  afterAll(async () => {
    await ctx?.db.$disconnect()
  })

  const signIn = (id: string) => ctx.db.connectionSignIn.findFirstOrThrow({ where: { id, organizationId: org } })
  const connection = (id: string) => ctx.db.connection.findFirstOrThrow({ where: { id, organizationId: org } })

  /** Runs the waiting jobs one at a time, at most `maxJobs`; the in-memory queue ignores delays. */
  async function step(maxJobs = 1) {
    const result = await ctx.queue.drain(ctx, jobs, { maxJobs })
    expect(result.failed).toEqual([])
  }

  /** The poll interval passes: the next poll may call the Channel again. */
  async function intervalPasses(id: string) {
    await ctx.db.$executeRaw`
      UPDATE "connection_sign_in" SET "lastPolledAt" = "lastPolledAt" - interval '1 hour'
      WHERE "id" = ${id} AND "organizationId" = ${org} AND "lastPolledAt" IS NOT NULL`
  }

  async function pollOnce(id: string) {
    await intervalPasses(id)
    await step()
  }

  async function startedSignIn(input: Parameters<typeof startSignIn>[2]) {
    const { signInId } = await startSignIn(ctx, org, input, user)
    await step()
    const row = await signIn(signInId)
    expect(row.status).toBe('pending')
    return { signInId, userCode: row.userCode! }
  }

  async function drainAll() {
    const result = await ctx.queue.drain(ctx, jobs)
    expect(result.failed).toEqual([])
    expect(ctx.queue.waiting).toEqual([])
  }

  it('refuses the form path and connectors that are not set up', async () => {
    await expect(
      addConnection(ctx, org, { connectorId: 'fake-oauth', name: 'x', config: {}, credentials: fake.issueCredentials() }, user),
    ).rejects.toMatchObject({ code: 'sign_in_required' })
    const bare = createTestContext({ databaseUrl: databaseUrl!, connectors: [fake.connector] })
    try {
      const error = await startSignIn(bare, org, { connectorId: 'fake-oauth', name: 'x', config: {} }, user).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(DomainError)
      expect(error).toMatchObject({ code: 'connector_not_configured', details: { variables: expect.arrayContaining(['HANZA_CONNECTOR_FAKE_OAUTH_CLIENT_ID']) } })
      expect(JSON.stringify(error)).not.toContain('test-secret')
    } finally {
      await bare.db.$disconnect()
    }
  })

  it('connects a new Connection: code shown, pending polls, approval, first sync', async () => {
    const { signInId } = await startSignIn(ctx, org, { connectorId: 'fake-oauth', name: 'My OAuth channel', config: {} }, user)
    expect(await getSignIn(ctx, org, signInId)).toMatchObject({ status: 'starting', userCode: null, reconnect: false })
    expect(ctx.queue.waiting.map((job) => job.name)).toEqual(['connections.signIn.start'])

    await step()
    const view = await getSignIn(ctx, org, signInId)
    expect(view).toMatchObject({
      status: 'pending',
      verificationUri: 'https://fake-oauth.hanza.test/activate',
      verificationUriComplete: expect.stringContaining('https://fake-oauth.hanza.test/activate?code='),
    })
    expect(view).not.toHaveProperty('deviceCode')
    expect(view!.userCode).toMatch(/^[A-Z]{9}$/)
    // The device code is stored sealed and the job carries ids only.
    const raw = await signIn(signInId)
    expect(raw.deviceCode).toMatch(/^v1:/)
    expect(raw.deviceCode).not.toContain('fake-device-')
    expect(raw.intervalSeconds).toBe(2)
    expect(ctx.queue.waiting).toEqual([
      {
        name: 'connections.signIn.poll',
        payload: { organizationId: org, signInId },
        options: { coalesceKey: coalesceKeys.signInPoll(signInId), delayMs: 2_000 },
      },
    ])
    expect(fake.clientIds).toContain('test-client')

    // First poll: not approved yet; it schedules the next one.
    await step()
    expect((await signIn(signInId)).status).toBe('pending')
    // A poll that comes before the interval has passed waits instead of calling the Channel.
    const polled = (await signIn(signInId)).lastPolledAt
    await step()
    expect((await signIn(signInId)).lastPolledAt).toEqual(polled)
    expect(ctx.queue.waiting).toHaveLength(1)

    fake.approve(view!.userCode!)
    await pollOnce(signInId)
    const approved = await getSignIn(ctx, org, signInId)
    expect(approved).toMatchObject({ status: 'approved', accountLabel: FAKE_OAUTH_DEFAULT_ACCOUNT.label })
    expect((await signIn(signInId)).deviceCode).toBeNull()
    connectionId = approved!.connectionId!
    expect(await connection(connectionId)).toMatchObject({
      name: 'My OAuth channel',
      connectorId: 'fake-oauth',
      accountId: FAKE_OAUTH_DEFAULT_ACCOUNT.id,
      accountLabel: FAKE_OAUTH_DEFAULT_ACCOUNT.label,
      health: 'unknown',
      credentialsVersion: 0,
    })
    const events = await ctx.db.eventLog.findMany({
      where: { organizationId: org, subjectType: 'connection', subjectId: connectionId },
      orderBy: { createdAt: 'asc' },
    })
    expect(events.map((event) => [event.type, event.payload])).toEqual([
      ['connection.created', { connectorId: 'fake-oauth', actor: user }],
      ['connection.signed_in', { connectorId: 'fake-oauth', account: 'fake-seller', actor: user }],
    ])
    expect(JSON.stringify(events)).not.toContain('fake-access-')

    await drainAll()
    expect((await connection(connectionId)).health).toBe('ok')
    expect(await ctx.db.order.count({ where: { organizationId: org, connectionId } })).toBe(4)
    expect(fake.tokenUses.length).toBeGreaterThan(0)
    expect(fake.tokenUses.every((use) => use.accepted)).toBe(true)
  })

  it('a duplicate poll after the approval does nothing', async () => {
    const before = await ctx.db.connection.count({ where: { organizationId: org } })
    const [row] = await ctx.db.connectionSignIn.findMany({ where: { organizationId: org, status: 'approved' } })
    await ctx.queue.enqueue(signInPollRef, { organizationId: org, signInId: row!.id })
    await drainAll()
    expect(await ctx.db.connection.count({ where: { organizationId: org } })).toBe(before)
  })

  it('slows down, and ends on denial or expiry with the device code cleared', async () => {
    const slow = await startedSignIn({ connectorId: 'fake-oauth', name: 'Slow', config: {} })
    fake.slowDown(slow.userCode)
    await step()
    expect((await signIn(slow.signInId)).intervalSeconds).toBe(2 + SLOW_DOWN_STEP_SECONDS)
    expect(ctx.queue.waiting.at(-1)?.options.delayMs).toBe((2 + SLOW_DOWN_STEP_SECONDS) * 1000)
    fake.deny(slow.userCode)
    await pollOnce(slow.signInId)
    expect(await signIn(slow.signInId)).toMatchObject({ status: 'denied', deviceCode: null })
    expect(ctx.queue.waiting).toEqual([])

    const late = await startedSignIn({ connectorId: 'fake-oauth', name: 'Late', config: {} })
    await ctx.db.connectionSignIn.updateMany({ where: { id: late.signInId, organizationId: org }, data: { expiresAt: new Date(Date.now() - 1000) } })
    expect(await getSignIn(ctx, org, late.signInId)).toMatchObject({ status: 'expired' })
    await step()
    expect(await signIn(late.signInId)).toMatchObject({ status: 'expired', deviceCode: null })
    expect(ctx.queue.waiting).toEqual([])
  })

  it('refuses a second Connection for a Channel account the organization already connected', async () => {
    const twice = await startedSignIn({ connectorId: 'fake-oauth', name: 'Same seller', config: {} })
    fake.approve(twice.userCode)
    await step()
    expect(await signIn(twice.signInId)).toMatchObject({ status: 'account_in_use', connectionId: null, deviceCode: null })
    expect(await ctx.db.connection.count({ where: { organizationId: org, connectorId: 'fake-oauth' } })).toBe(1)
  })

  it('cancels a sign-in that has not finished', async () => {
    const cancelled = await startedSignIn({ connectorId: 'fake-oauth', name: 'Cancelled', config: {} })
    await cancelSignIn(ctx, org, cancelled.signInId)
    expect(await signIn(cancelled.signInId)).toMatchObject({ status: 'cancelled', deviceCode: null })
    fake.approve(cancelled.userCode)
    await drainAll()
    expect((await signIn(cancelled.signInId)).status).toBe('cancelled')
  })

  it('signs in again after auth_expired: a different account is refused, the same one brings the Connection back', async () => {
    fake.revokeAll()
    await requestSync(ctx, org, connectionId)
    await ctx.queue.drain(ctx, jobs)
    expect((await connection(connectionId)).health).toBe('auth_expired')
    const stored = await connection(connectionId)

    const other = await startedSignIn({ connectionId })
    expect(await getSignIn(ctx, org, other.signInId)).toMatchObject({ reconnect: true, connectionId, name: null })
    fake.approve(other.userCode, { id: 'another-seller', label: 'another' })
    await step()
    expect(await signIn(other.signInId)).toMatchObject({ status: 'account_mismatch', accountLabel: 'another' })
    expect(await connection(connectionId)).toMatchObject({ credentials: stored.credentials, credentialsVersion: 0, health: 'auth_expired' })

    const again = await startedSignIn({ connectionId })
    fake.approve(again.userCode)
    await step()
    expect(await signIn(again.signInId)).toMatchObject({ status: 'approved', connectionId })
    const renewed = await connection(connectionId)
    expect(renewed).toMatchObject({ health: 'unknown', credentialsVersion: 1, accountId: FAKE_OAUTH_DEFAULT_ACCOUNT.id })
    expect(renewed.credentials).not.toBe(stored.credentials)
    const health = await ctx.db.eventLog.findMany({
      where: { organizationId: org, subjectId: connectionId, type: { in: ['connection.health_changed', 'connection.signed_in'] } },
      orderBy: { createdAt: 'asc' },
    })
    expect(health.map((event) => event.type).slice(-2)).toEqual(['connection.health_changed', 'connection.signed_in'])
    expect(health.at(-2)?.payload).toMatchObject({ from: 'auth_expired', to: 'unknown' })

    await drainAll()
    expect((await connection(connectionId)).health).toBe('ok')
    // The tick schedules it again (it skips only auth_expired Connections).
    await ctx.db.syncState.updateMany({ where: { organizationId: org, connectionId }, data: { lastStartedAt: new Date(0) } })
    await ctx.queue.enqueue(syncTickRef, {})
    await ctx.queue.drain(ctx, jobs, { maxJobs: 1 })
    const own = ctx.queue.waiting.filter((job) => (job.payload as { connectionId?: string }).connectionId === connectionId)
    expect(own.map((job) => job.name).sort()).toEqual(['offers.pull', 'orders.pull', 'stock.push'])
    ctx.queue.waiting.length = 0
  })

  it('keeps sign-ins scoped to their organization', async () => {
    const otherOrg = await createTestOrganization(ctx.db)
    const [row] = await ctx.db.connectionSignIn.findMany({ where: { organizationId: org }, take: 1 })
    expect(await getSignIn(ctx, otherOrg, row!.id)).toBeNull()
    await expect(cancelSignIn(ctx, otherOrg, row!.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(startSignIn(ctx, otherOrg, { connectionId }, user)).rejects.toMatchObject({ code: 'not_found' })
    // A poll job with a foreign organization id finds nothing.
    await ctx.queue.enqueue(signInPollRef, { organizationId: otherOrg, signInId: row!.id })
    await drainAll()
  })

  it('the sweep expires stale sign-ins and deletes ended ones after a day', async () => {
    const stale = await startedSignIn({ connectorId: 'fake-oauth', name: 'Stale', config: {} })
    ctx.queue.waiting.length = 0
    const now = new Date()
    await ctx.db.connectionSignIn.updateMany({ where: { id: stale.signInId, organizationId: org }, data: { expiresAt: new Date(now.getTime() - 1) } })
    const first = await sweepSignIns(ctx, now)
    expect(first.expired).toBeGreaterThanOrEqual(1)
    expect(await signIn(stale.signInId)).toMatchObject({ status: 'expired', deviceCode: null })

    const ended = await ctx.db.connectionSignIn.count({ where: { organizationId: org } })
    await sweepSignIns(ctx, new Date(now.getTime() + SIGN_IN_KEEP_MS + 1_000))
    expect(await ctx.db.connectionSignIn.count({ where: { organizationId: org } })).toBe(0)
    expect(ended).toBeGreaterThan(0)
  })
})
