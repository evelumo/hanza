import { createFakeChannel, type FakeApiRequest, type FakeChannel } from '@hanza/connector-fake'
import {
  addConnection,
  createRedisRateLimiter,
  offersPullJob,
  ordersPullJob,
  PermanentJobError,
  RetryLaterError,
  type Actor,
  type Context,
  type JobDefinition,
  type RateLimiter,
} from '@hanza/core'
import {
  createInMemoryRateLimiter,
  createTestContext,
  createTestOrganization,
  reachableTestRedis,
  testRedisPrefix,
  type TestContext,
} from '@hanza/core/testing'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'

const databaseUrl = inject('hanzaTestDatabaseUrl')
const redisUrl = await reachableTestRedis()
const user: Actor = { type: 'user', userId: 'user-1' }
const silent = { info() {}, warn() {}, error() {} }
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const CONNECTOR_ID = 'fake-limited'
const WINDOW_MS = 500
const APP_REQUESTS = 4
const CONNECTION_REQUESTS = 3
// A request reaches the Channel a little after its reserved slot (timer and Redis round trip), never before it.
const ARRIVAL_JITTER_MS = 100

function order(externalId: string): Parameters<FakeChannel['addOrder']>[0] {
  return {
    externalId,
    placedAt: '2026-10-06T09:00:00Z',
    payment: 'prepaid',
    total: { amount: '10.00', currency: 'PLN' },
    buyer: { name: 'Rate Test', email: null, phone: null, login: null },
    shippingAddress: {
      name: 'Rate Test',
      company: null,
      street: '1 Example Street',
      postalCode: '00-001',
      city: 'Warsaw',
      countryCode: 'PL',
      phone: null,
      taxId: null,
    },
    billingAddress: null,
    lines: [{ externalId: 'l1', offerExternalId: 'fake-offer-1', sku: 'FAKE-SKU-1', name: 'Mug', quantity: 1, unitPrice: { amount: '10.00', currency: 'PLN' } }],
    facts: [],
  }
}

/** The most requests found in any window of `windowMs` (half-open), by arrival time. */
function busiestWindow(requests: FakeApiRequest[], windowMs: number): number {
  const times = requests.map((request) => request.at).sort((a, b) => a - b)
  let most = 0
  for (let start = 0, end = 0; end < times.length; end++) {
    while (times[end]! - times[start]! >= windowMs) start++
    most = Math.max(most, end - start + 1)
  }
  return most
}

type Variant = { name: string; limiters: () => Promise<{ one: RateLimiter; two: RateLimiter; close(): Promise<void> }> }

const variants: Variant[] = [
  {
    name: 'one in-memory limiter shared by two worker contexts',
    async limiters() {
      const shared = createInMemoryRateLimiter()
      return { one: shared, two: shared, close: async () => {} }
    },
  },
]
if (redisUrl) {
  variants.push({
    name: 'two Redis limiters, as two worker processes',
    async limiters() {
      const { prefix, cleanup } = testRedisPrefix(redisUrl)
      const one = createRedisRateLimiter(redisUrl, { prefix, log: silent })
      const two = createRedisRateLimiter(redisUrl, { prefix, log: silent })
      return {
        one,
        two,
        async close() {
          await Promise.all([one.close(), two.close()])
          await cleanup()
        },
      }
    },
  })
}

describe.skipIf(!databaseUrl).each(variants)('shared rate limits end to end ($name)', ({ limiters }) => {
  let ctx: TestContext
  let workerOne: Context
  let workerTwo: Context
  let fake: FakeChannel
  let close: () => Promise<void>
  const connections: Array<{ org: string; connectionId: string; apiKey: string }> = []

  beforeAll(async () => {
    fake = createFakeChannel({
      id: CONNECTOR_ID,
      http: true,
      rateLimits: {
        application: { requests: APP_REQUESTS, windowMs: WINDOW_MS },
        connection: { rate: { requests: CONNECTION_REQUESTS, windowMs: WINDOW_MS }, concurrency: 1 },
      },
    })
    fake.api.latencyMs = 10
    for (let i = 1; i <= 7; i++) fake.addOrder(order(`rate-order-${i}`))
    // The stub serves only the fake Channel's URL; nothing else in these tests uses fetch (Prisma talks to Postgres directly).
    vi.stubGlobal('fetch', fake.api.fetch)

    const built = await limiters()
    close = built.close
    ctx = createTestContext({ databaseUrl: databaseUrl!, connectors: [fake.connector], rateLimiter: built.one })
    workerOne = ctx
    workerTwo = { ...ctx, rateLimiter: built.two }
    // Two organizations: the application budget is shared across tenants, the Connection budget is not.
    for (const apiKey of ['key-a', 'key-b']) {
      const org = await createTestOrganization(ctx.db)
      const { connectionId } = await addConnection(
        ctx,
        org,
        { connectorId: CONNECTOR_ID, name: `Limited ${apiKey}`, config: { failMode: 'none' }, credentials: { apiKey } },
        user,
      )
      connections.push({ org, connectionId, apiKey })
    }
    // The first-sync jobs addConnection enqueued are run by hand below.
    ctx.queue.waiting.length = 0
  })

  afterAll(async () => {
    vi.unstubAllGlobals()
    await ctx?.db.$disconnect()
    await close?.()
  })

  /** What BullMQ does with a job: a RetryLaterError waits its delay and runs again without using an attempt. */
  async function runJob(worker: Context, job: JobDefinition, payload: unknown, delays: number[] = []): Promise<void> {
    for (let retriedLater = 0; ; retriedLater++) {
      try {
        await job.handler(worker, job.schema.parse(payload), { attempt: 1, maxAttempts: 5, retriedLater })
        return
      } catch (error) {
        if (!(error instanceof RetryLaterError)) throw error
        delays.push(error.delayMs)
        await sleep(error.delayMs)
      }
    }
  }

  const pull = (connection: (typeof connections)[number]) => ({
    organizationId: connection.org,
    connectionId: connection.connectionId,
    trigger: 'schedule' as const,
  })

  async function health(connection: (typeof connections)[number]) {
    const row = await ctx.db.connection.findFirstOrThrow({ where: { id: connection.connectionId, organizationId: connection.org } })
    return row.health
  }

  async function ordersState(connection: (typeof connections)[number]) {
    return ctx.db.syncState.findFirstOrThrow({
      where: { organizationId: connection.org, connectionId: connection.connectionId, stream: 'orders_pull' },
    })
  }

  it('runs concurrent pulls of two Connections on two workers without ever exceeding either budget', async () => {
    const [a, b] = connections as [(typeof connections)[number], (typeof connections)[number]]
    const started = Date.now()
    await Promise.all([
      runJob(workerOne, offersPullJob, pull(a)),
      runJob(workerTwo, ordersPullJob, pull(a)),
      runJob(workerOne, ordersPullJob, pull(b)),
      runJob(workerTwo, offersPullJob, pull(b)),
    ])
    const elapsed = Date.now() - started

    // Everything arrived: 5 Offers in pages of 2, and 12 journal entries (11 Orders) in pages of 2, per Connection.
    for (const connection of connections) {
      expect(await ctx.db.offer.count({ where: { organizationId: connection.org, connectionId: connection.connectionId } })).toBe(5)
      expect(await ctx.db.order.count({ where: { organizationId: connection.org, connectionId: connection.connectionId } })).toBe(11)
      expect(await health(connection)).toBe('ok')
    }
    const requests = fake.api.requests
    expect(requests.length).toBeGreaterThanOrEqual(18)

    // The budgets held, measured where the Channel would count them.
    const window = WINDOW_MS - ARRIVAL_JITTER_MS
    expect(busiestWindow(requests, window)).toBeLessThanOrEqual(APP_REQUESTS)
    for (const { apiKey } of connections) {
      expect(busiestWindow(requests.filter((request) => request.apiKey === apiKey), window)).toBeLessThanOrEqual(CONNECTION_REQUESTS)
      expect(fake.api.maxInFlight.get(apiKey)).toBe(1)
    }
    // And they bit: 18 requests at 4 per 500 ms cannot be sent faster than this.
    expect(elapsed).toBeGreaterThanOrEqual(Math.floor((18 - APP_REQUESTS) / APP_REQUESTS) * WINDOW_MS)
  })

  it('a 429 parks both budgets for its Retry-After and delays the job; the Connection stays ok', async () => {
    const [a, b] = connections as [(typeof connections)[number], (typeof connections)[number]]
    await sleep(WINDOW_MS)
    fake.api.reset()
    fake.api.failNext(429, { headers: { 'Retry-After': '1' } })
    const delays: number[] = []
    // A's request gets the 429; B's waits for the park to end instead of adding to the Channel's anger.
    await Promise.all([runJob(workerOne, ordersPullJob, pull(a), delays), sleep(50).then(() => runJob(workerTwo, offersPullJob, pull(b)))])

    expect(delays).toEqual([1000])
    const [limited, ...after] = fake.api.requests
    expect(limited?.apiKey).toBe('key-a')
    expect(after.length).toBeGreaterThan(0)
    for (const request of after) expect(request.at - limited!.at).toBeGreaterThanOrEqual(1000 - ARRIVAL_JITTER_MS)
    expect(await health(a)).toBe('ok')
    expect(await health(b)).toBe('ok')
    expect((await ordersState(a)).lastErrorKind).toBeNull()
  })

  it('a park longer than the wait delays other jobs without contacting the Channel, until the budget recovers', async () => {
    const [a, b] = connections as [(typeof connections)[number], (typeof connections)[number]]
    fake.api.reset()
    fake.api.failNext(429, { headers: { 'Retry-After': '3' } })
    const run = { attempt: 1, maxAttempts: 5, retriedLater: 0 }
    await expect(ordersPullJob.handler(workerOne, pull(a), run)).rejects.toMatchObject({ name: 'RetryLaterError', delayMs: 3000 })
    expect((await ordersState(a)).lastErrorKind).toBe('rate_limited')

    // B (another organization) is held by the application budget before it sends anything.
    const denied = await ordersPullJob.handler(workerTwo, pull(b), run).catch((error: unknown) => error)
    expect(denied).toBeInstanceOf(RetryLaterError)
    expect((denied as RetryLaterError).delayMs).toBeGreaterThan(2000)
    expect((await ordersState(b)).lastErrorKind).toBe('rate_limited')
    expect(fake.api.requests).toHaveLength(1)
    expect(await health(a)).toBe('ok')
    expect(await health(b)).toBe('ok')

    await sleep(3000)
    await ordersPullJob.handler(workerOne, pull(a), run)
    await ordersPullJob.handler(workerTwo, pull(b), run)
    expect((await ordersState(a)).lastErrorKind).toBeNull()
    expect((await ordersState(b)).lastErrorKind).toBeNull()
    expect(fake.api.requests).toHaveLength(3)
  })

  it('a 403 fails the run as permanent and marks the Connection failing, not signed out; a 401 asks for sign-in', async () => {
    const [a] = connections as [(typeof connections)[number]]
    const run = { attempt: 1, maxAttempts: 5, retriedLater: 0 }
    fake.api.failNext(403)
    await expect(ordersPullJob.handler(workerOne, pull(a), run)).rejects.toBeInstanceOf(PermanentJobError)
    expect(await ordersState(a)).toMatchObject({ lastErrorKind: 'permanent', lastError: '403 Forbidden' })
    expect(await health(a)).toBe('failing')

    // Nothing to sign in again for: the next run just works.
    await ordersPullJob.handler(workerOne, pull(a), run)
    expect(await health(a)).toBe('ok')

    fake.api.failNext(401)
    await expect(ordersPullJob.handler(workerOne, pull(a), run)).rejects.toBeInstanceOf(PermanentJobError)
    expect(await ordersState(a)).toMatchObject({ lastErrorKind: 'auth_expired', lastError: '401 Unauthorized' })
    expect(await health(a)).toBe('auth_expired')
  })
})
