import { AuthExpiredError, defineConnector } from '@hanza/connector-sdk'
import { createDb } from '@hanza/db'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DomainError } from '../errors'
import { PermanentJobError, type JobRunInfo } from '../jobs'
import { offersPullJob } from '../jobs/offers-pull'
import { ordersPullJob } from '../jobs/orders-pull'
import { pricePushJob } from '../jobs/price-push'
import { coalesceKeys } from '../jobs/refs'
import { stockPushJob } from '../jobs/stock-push'
import { syncTickJob } from '../jobs/sync-tick'
import { SYNC_INTERVALS_MS } from '../sync/schedule'
import { createTestOrganization, type TestContext } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { testCourier, user } from '../testing/fixtures'
import { uniqueApplicationName, untilLockWait } from '../testing/lock-waits'
import { createConnection, openConnection } from './connections'
import { hasCredentialsForm, refreshCredentials } from './credentials'
import { replaceCredentials } from './replace-credentials'

// What the Channel was called with, and the keys it refuses, as the fake Channel refuses `expired`.
const calledWith: string[] = []
const refused = new Set(['expired'])
// Set by a test to keep a call to the Channel in flight until it lets go.
let inFlight: { entered: () => void; proceed: Promise<void> } | null = null

async function call(apiKey: string): Promise<void> {
  calledWith.push(apiKey)
  if (inFlight) {
    const { entered, proceed } = inFlight
    inFlight = null
    entered()
    await proceed
  }
  if (refused.has(apiKey)) throw new AuthExpiredError('The API key has expired')
}

const keyChannel = defineConnector({
  id: 'key-channel',
  name: 'Key channel',
  kind: 'shop',
  auth: { type: 'apiKey' },
  configSchema: z.object({ shop: z.string().min(1) }),
  credentialsSchema: z.object({ apiKey: z.string().min(1).max(40) }),
  capabilities: {
    async 'offers.pull'(ctx) {
      await call(ctx.credentials.apiKey)
      return { items: [], nextCursor: null, hasMore: false }
    },
    async 'orders.pull'(ctx, cursor) {
      await call(ctx.credentials.apiKey)
      return { items: [], nextCursor: cursor, hasMore: false }
    },
    async 'stock.push'() {},
  },
})

const deviceChannel = defineConnector({
  ...keyChannel,
  id: 'device-channel',
  auth: {
    type: 'oauth2',
    deviceFlow: {
      async start() {
        throw new Error('no sign-in in this test')
      },
      async poll() {
        return { status: 'pending' }
      },
      verificationHosts: ['channel.example.test'],
    },
  },
})

type Tokens = { accessToken: string; refreshToken: string }
let refreshing: (credentials: Tokens) => Promise<Tokens> = async () => {
  throw new Error('no refresh in this test')
}
// Tokens typed into the form and refreshed by the core: the one kind of connector whose runs take the credentials lock
// and whose credentials can still be replaced by hand.
const tokenChannel = defineConnector({
  id: 'token-channel',
  name: 'Token channel',
  kind: 'shop',
  auth: { type: 'oauth2', refresh: (_ctx, credentials) => refreshing(credentials) },
  configSchema: z.object({}),
  credentialsSchema: z.object({ accessToken: z.string().min(1), refreshToken: z.string().min(1) }),
  capabilities: {
    async 'offers.pull'() {
      return { items: [], nextCursor: null, hasMore: false }
    },
    async 'orders.pull'(_ctx, cursor) {
      return { items: [], nextCursor: cursor, hasMore: false }
    },
    async 'stock.push'() {},
  },
})

const run: JobRunInfo = { attempt: 1, maxAttempts: 5, retriedLater: 0 }
const syncJobs = [offersPullJob, ordersPullJob, stockPushJob, pricePushJob]
const applicationName = uniqueApplicationName('hanza-replace-credentials')

describe('hasCredentialsForm', () => {
  it('is true only for a connector without a device flow that declares a credentials field', () => {
    expect(hasCredentialsForm(keyChannel)).toBe(true)
    expect(hasCredentialsForm(tokenChannel)).toBe(true)
    expect(hasCredentialsForm(deviceChannel)).toBe(false)
    expect(hasCredentialsForm(testCourier)).toBe(false)
  })
})

describe.skipIf(!databaseUrl)('replaceCredentials', () => {
  const context = useTestContext({ applicationName, connectors: [keyChannel, deviceChannel, tokenChannel, testCourier] })

  async function setup(apiKey = 'expired', connectorId = 'key-channel') {
    const ctx = context()
    // The queue is shared by the tests of this file: what an earlier one left waiting is not this one's.
    ctx.queue.waiting.length = 0
    const organizationId = await createTestOrganization(ctx.db)
    const { connectionId } = await createConnection(
      ctx,
      organizationId,
      { connectorId, name: 'Shop', config: { shop: 'https://shop.example.test' }, credentials: { apiKey } },
      user,
    )
    const row = () => ctx.db.connection.findFirstOrThrow({ where: { id: connectionId, organizationId } })
    const events = (type: string) => ctx.db.eventLog.findMany({ where: { organizationId, type }, orderBy: { id: 'asc' } })
    const pullOrders = () => ordersPullJob.handler(ctx, { organizationId, connectionId, trigger: 'schedule' }, run)
    const enqueuedSince = (index: number) =>
      ctx.queue.enqueued.slice(index).filter((job) => (job.payload as { connectionId?: string }).connectionId === connectionId)
    return { ctx, organizationId, connectionId, row, events, pullOrders, enqueuedSince }
  }

  /** A Connection whose key the Channel refused: its health is `auth_expired`. */
  async function setupExpired() {
    const t = await setup('expired')
    await expect(t.pullOrders()).rejects.toBeInstanceOf(PermanentJobError)
    expect((await t.row()).health).toBe('auth_expired')
    return t
  }

  const tick = (ctx: TestContext) => syncTickJob.handler(ctx, {}, run)

  it('stores the new credentials sealed, resets health, records who did it, and the Connection syncs again', async () => {
    const { ctx, organizationId, connectionId, row, events, enqueuedSince } = await setupExpired()
    const before = ctx.queue.enqueued.length
    const sealedBefore = (await row()).credentials

    // A key the form's schema does not declare is dropped, as when the Connection was added.
    await replaceCredentials(ctx, organizationId, connectionId, { apiKey: 'fresh-key-4711', other: 'undeclared-value' }, user)

    const stored = await row()
    expect(stored).toMatchObject({ health: 'unknown', credentialsVersion: 1, config: { shop: 'https://shop.example.test' } })
    expect(stored.credentials).toMatch(/^v1:/)
    expect(stored.credentials).not.toBe(sealedBefore)
    // Sealed: no column of the row holds what was typed.
    expect(JSON.stringify(stored)).not.toContain('fresh-key-4711')
    expect(await openConnection(ctx, organizationId, connectionId)).toMatchObject({ credentials: { apiKey: 'fresh-key-4711' }, credentialsVersion: 1 })

    expect((await events('connection.credentials_replaced')).map((event) => event.payload)).toEqual([{ connectorId: 'key-channel', actor: user }])
    expect((await events('connection.health_changed')).map((event) => event.payload)).toEqual([
      { from: 'unknown', to: 'auth_expired', errorKind: 'auth_expired' },
      { from: 'auth_expired', to: 'unknown', errorKind: null },
    ])
    const everyEvent = await ctx.db.eventLog.findMany({ where: { organizationId } })
    expect(JSON.stringify(everyEvent)).not.toContain('fresh-key-4711')
    expect(JSON.stringify(everyEvent)).not.toContain('undeclared-value')

    // What "Synchronise now" enqueues: Offers (which then pull Orders) and prices. This Connection's Order feed has
    // never caught up (its key failed on the first pull), so stock waits for the Orders pull to ask for it (#125).
    expect(enqueuedSince(before)).toEqual([
      { name: 'offers.pull', payload: { organizationId, connectionId, trigger: 'manual' }, options: { coalesceKey: coalesceKeys.offersPull(connectionId) } },
      { name: 'price.push', payload: { organizationId, connectionId }, options: { coalesceKey: coalesceKeys.pricePush(connectionId) } },
    ])

    calledWith.length = 0
    expect(await ctx.queue.drain(ctx, syncJobs)).toMatchObject({ failed: [] })
    expect(calledWith).toEqual(['fresh-key-4711', 'fresh-key-4711'])
    expect((await row()).health).toBe('ok')
    const states = await ctx.db.syncState.findMany({ where: { organizationId, connectionId, stream: { in: ['offers_pull', 'orders_pull'] } } })
    expect(states.map((state) => state.lastErrorKind)).toEqual([null, null])
  })

  it('is idempotent: the same credentials again leave the same state, with one more Event', async () => {
    const { ctx, organizationId, connectionId, row, events } = await setupExpired()
    await replaceCredentials(ctx, organizationId, connectionId, { apiKey: 'fresh-key' }, user)
    await replaceCredentials(ctx, organizationId, connectionId, { apiKey: 'fresh-key' }, user)

    expect(await row()).toMatchObject({ health: 'unknown', credentialsVersion: 2 })
    expect(await openConnection(ctx, organizationId, connectionId)).toMatchObject({ credentials: { apiKey: 'fresh-key' } })
    expect(await events('connection.credentials_replaced')).toHaveLength(2)
    // Health did not change the second time, so it is not recorded twice.
    expect(await events('connection.health_changed')).toHaveLength(2)
  })

  it('replaces the credentials of a working Connection too, which is then not checked until a run proves them', async () => {
    const { ctx, organizationId, connectionId, row, pullOrders } = await setup('first-key')
    await pullOrders()
    expect((await row()).health).toBe('ok')

    await replaceCredentials(ctx, organizationId, connectionId, { apiKey: 'rotated-key' }, user)
    expect((await row()).health).toBe('unknown')
    calledWith.length = 0
    await ctx.queue.drain(ctx, syncJobs)
    expect(new Set(calledWith)).toEqual(new Set(['rotated-key']))
    expect((await row()).health).toBe('ok')
  })

  it('stores a key the Channel refuses, and the run that follows says so', async () => {
    const { ctx, organizationId, connectionId, row } = await setupExpired()
    refused.add('wrong-key')
    try {
      await replaceCredentials(ctx, organizationId, connectionId, { apiKey: 'wrong-key' }, user)
      expect((await row()).health).toBe('unknown')
      await ctx.queue.drain(ctx, syncJobs)
      expect((await row()).health).toBe('auth_expired')
    } finally {
      refused.delete('wrong-key')
    }
  })

  it('refuses a connector that signs in with a device flow, and one without credential fields', async () => {
    const device = await setup('expired', 'device-channel')
    await expect(replaceCredentials(device.ctx, device.organizationId, device.connectionId, { apiKey: 'fresh-key' }, user)).rejects.toMatchObject({
      name: 'DomainError',
      code: 'sign_in_required',
    })
    expect(await device.row()).toMatchObject({ credentialsVersion: 0 })
    expect(await device.events('connection.credentials_replaced')).toEqual([])

    const ctx = context()
    const organizationId = await createTestOrganization(ctx.db)
    const { connectionId } = await createConnection(ctx, organizationId, { connectorId: 'test-courier', name: 'Courier', config: {}, credentials: {} }, user)
    await expect(replaceCredentials(ctx, organizationId, connectionId, { apiKey: 'fresh-key' }, user)).rejects.toMatchObject({ code: 'no_credentials' })
    expect(await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId, organizationId } })).toMatchObject({ credentialsVersion: 0 })
  })

  it('refuses input the connector does not accept, naming the field and never the value, and changes nothing', async () => {
    const { ctx, organizationId, connectionId, row, events, enqueuedSince } = await setupExpired()
    const before = ctx.queue.enqueued.length
    const untouched = await row()

    const tooLong = `typed-secret-${'x'.repeat(40)}`
    for (const input of [{}, { apiKey: '' }, { apiKey: tooLong }, null, 'typed-secret']) {
      const error: unknown = await replaceCredentials(ctx, organizationId, connectionId, input, user).catch((thrown: unknown) => thrown)
      expect(error).toBeInstanceOf(DomainError)
      expect(error).toMatchObject({ code: 'invalid_config' })
      expect(JSON.stringify([(error as DomainError).message, (error as DomainError).details])).not.toContain('typed-secret')
    }
    await expect(replaceCredentials(ctx, organizationId, connectionId, { apiKey: tooLong }, user)).rejects.toMatchObject({
      details: { issues: [{ path: 'credentials.apiKey' }] },
    })

    expect(await row()).toEqual(untouched)
    expect(await events('connection.credentials_replaced')).toEqual([])
    expect(enqueuedSince(before)).toEqual([])
  })

  it('does not find a Connection of another organization', async () => {
    const { ctx, connectionId, row, events } = await setupExpired()
    const other = await createTestOrganization(ctx.db)
    const before = ctx.queue.enqueued.length
    const untouched = await row()

    await expect(replaceCredentials(ctx, other, connectionId, { apiKey: 'fresh-key' }, user)).rejects.toMatchObject({ code: 'not_found' })
    await expect(replaceCredentials(ctx, other, 'no-such-connection', { apiKey: 'fresh-key' }, user)).rejects.toMatchObject({ code: 'not_found' })

    expect(await row()).toEqual(untouched)
    expect(await events('connection.credentials_replaced')).toEqual([])
    expect(await ctx.db.eventLog.count({ where: { organizationId: other } })).toBe(0)
    expect(ctx.queue.enqueued.slice(before)).toEqual([])
  })

  it('the tick skips the Connection while it waits for sign-in and schedules it again afterwards, also when the enqueue was lost', async () => {
    const { ctx, organizationId, connectionId, enqueuedSince } = await setupExpired()
    // Every stream is long overdue.
    for (const stream of ['offers_pull', 'orders_pull', 'stock_push', 'price_push'] as const) {
      const lastStartedAt = new Date(Date.now() - 2 * SYNC_INTERVALS_MS.offers_pull)
      await ctx.db.syncState.upsert({
        where: { connectionId_stream: { connectionId, stream } },
        create: { organizationId, connectionId, stream, lastStartedAt },
        update: { lastStartedAt },
      })
    }
    let before = ctx.queue.enqueued.length
    await tick(ctx)
    expect(enqueuedSince(before)).toEqual([])

    // Redis is away when the credentials are replaced: they are stored all the same, and nothing was enqueued.
    const offline: TestContext = {
      ...ctx,
      queue: {
        ...ctx.queue,
        async enqueue() {
          throw new Error('Connection is closed.')
        },
      },
    }
    before = ctx.queue.enqueued.length
    await replaceCredentials(offline, organizationId, connectionId, { apiKey: 'fresh-key' }, user)
    expect(await openConnection(ctx, organizationId, connectionId)).toMatchObject({ credentials: { apiKey: 'fresh-key' }, health: 'unknown' })
    expect(enqueuedSince(before)).toEqual([])

    // The connector has no `price.push`, so the tick leaves that stream out.
    await tick(ctx)
    expect(enqueuedSince(before).map((job) => [job.name, (job.payload as { trigger?: string }).trigger])).toEqual([
      ['offers.pull', 'schedule'],
      ['orders.pull', 'schedule'],
      ['stock.push', undefined],
    ])
    await ctx.queue.drain(ctx, syncJobs)
    expect((await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId, organizationId } })).health).toBe('ok')
  })

  it('serialises two replacements of one Connection', async () => {
    const { ctx, organizationId, connectionId, row, events } = await setupExpired()
    await Promise.all([
      replaceCredentials(ctx, organizationId, connectionId, { apiKey: 'key-a' }, user),
      replaceCredentials(ctx, organizationId, connectionId, { apiKey: 'key-b' }, user),
    ])
    expect(await row()).toMatchObject({ health: 'unknown', credentialsVersion: 2 })
    const opened = await openConnection(ctx, organizationId, connectionId)
    expect(['key-a', 'key-b']).toContain((opened!.credentials as { apiKey: string }).apiKey)
    expect(await events('connection.credentials_replaced')).toHaveLength(2)
  })

  it('waits for a refresh that holds the credentials lock, then writes over what it stored', async () => {
    const ctx = context()
    const organizationId = await createTestOrganization(ctx.db)
    const { connectionId } = await createConnection(
      ctx,
      organizationId,
      { connectorId: 'token-channel', name: 'Tokens', config: {}, credentials: { accessToken: 'access-0', refreshToken: 'refresh-0' } },
      user,
    )
    // The Channel is slow to answer the token request: the refresh holds the lock, inside its transaction, until it does.
    let answer!: () => void
    const answered = new Promise<void>((resolve) => (answer = resolve))
    let asked!: () => void
    const isAsked = new Promise<void>((resolve) => (asked = resolve))
    refreshing = async (credentials) => {
      expect(credentials).toEqual({ accessToken: 'access-0', refreshToken: 'refresh-0' })
      asked()
      await answered
      return { accessToken: 'access-1', refreshToken: 'refresh-1' }
    }
    const observer = createDb(databaseUrl!)
    try {
      const refresh = refreshCredentials(ctx, { organizationId, connectionId, connector: tokenChannel, app: {}, seenVersion: 0, force: true })
      await isAsked
      let replaced = false
      const replacing = replaceCredentials(ctx, organizationId, connectionId, { accessToken: 'typed-access', refreshToken: 'typed-refresh' }, user).then(() => {
        replaced = true
      })
      // The replacement waits on the lock: nothing of it is stored while the refresh is in flight.
      await untilLockWait(observer, applicationName)
      expect(replaced).toBe(false)
      expect(await openConnection(ctx, organizationId, connectionId)).toMatchObject({ credentials: { accessToken: 'access-0' }, credentialsVersion: 0 })

      answer()
      expect(await refresh).toMatchObject({ refreshed: true, version: 1 })
      await replacing
      // The refresh wrote first (version 1), the replacement after it (version 2): the typed credentials are the stored ones.
      expect(await openConnection(ctx, organizationId, connectionId)).toMatchObject({
        credentials: { accessToken: 'typed-access', refreshToken: 'typed-refresh' },
        credentialsVersion: 2,
      })
      // A run that read version 1 before the replacement and is refused does not refresh the replaced ones: it re-reads them.
      refreshing = async () => {
        throw new Error('a refresh of replaced credentials')
      }
      expect(
        await refreshCredentials(ctx, { organizationId, connectionId, connector: tokenChannel, app: {}, seenVersion: 1, force: true }),
      ).toMatchObject({ refreshed: false, version: 2, credentials: { accessToken: 'typed-access' } })
    } finally {
      answer()
      await observer.$disconnect()
    }
  })

  it('does not wait for a run in flight, which finishes with the credentials it started with; the run that follows uses the new ones', async () => {
    const { ctx, organizationId, connectionId, row, pullOrders } = await setup('first-key')
    let proceed!: () => void
    let entered!: () => void
    const isEntered = new Promise<void>((resolve) => (entered = resolve))
    inFlight = { entered, proceed: new Promise<void>((resolve) => (proceed = resolve)) }
    calledWith.length = 0
    try {
      const running = pullOrders()
      await isEntered
      // The shop revokes the old key while the call is in flight, and the new one is typed in.
      await replaceCredentials(ctx, organizationId, connectionId, { apiKey: 'second-key' }, user)
      refused.add('first-key')
      proceed()
      // The call in flight was made with the old key alone, and is refused as the Channel refuses that key.
      await expect(running).rejects.toBeInstanceOf(PermanentJobError)
      expect(calledWith).toEqual(['first-key'])

      // The streams the replacement enqueued run after it, with the stored key, and the Connection works.
      await ctx.queue.drain(ctx, syncJobs)
      expect(calledWith).toEqual(['first-key', 'second-key', 'second-key'])
      expect(await row()).toMatchObject({ health: 'ok', credentialsVersion: 1 })
    } finally {
      proceed()
      inFlight = null
      refused.delete('first-key')
    }
  })
})
