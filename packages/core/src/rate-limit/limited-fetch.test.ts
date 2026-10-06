import { RateLimitedError, defineConnector, type RateLimits } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Logger } from '../logger'
import { limitFetch, ratePlan, type Clock } from './limited-fetch'
import { createInMemoryRateLimiter } from './memory'

function connector(rateLimits?: RateLimits, id = 'limited') {
  return defineConnector({
    id,
    name: 'Limited',
    kind: 'courier',
    auth: { type: 'none' },
    configSchema: z.object({}),
    credentialsSchema: z.object({}),
    capabilities: {},
    ...(rateLimits ? { rateLimits } : {}),
  })
}

function fakeClock(): Clock & { slept: number[] } {
  let now = 1_000_000
  const slept: number[] = []
  return {
    slept,
    now: () => now,
    async sleep(ms) {
      slept.push(ms)
      now += ms
      // Lets other pending calls run, as a real timer would.
      await new Promise((resolve) => setImmediate(resolve))
    },
  }
}

function recordingLog(): Logger & { lines: Array<[string, Record<string, unknown> | undefined]> } {
  const lines: Array<[string, Record<string, unknown> | undefined]> = []
  const record = (message: string, fields?: Record<string, unknown>) => void lines.push([message, fields])
  return { lines, info: record, warn: record, error: record }
}

const ok = () => new Response(null, { status: 204 })

function setup(rateLimits: RateLimits, options: { respond?: () => Response | Promise<Response> } = {}) {
  const clock = fakeClock()
  const limiter = createInMemoryRateLimiter({ now: clock.now })
  const log = recordingLog()
  const sent: string[] = []
  const base = (async (input: Parameters<typeof fetch>[0]) => {
    sent.push(String(input))
    return (options.respond ?? ok)()
  }) as typeof fetch
  const definition = connector(rateLimits)
  const fetchFor = (connectionId: string) => limitFetch(base, ratePlan(definition, connectionId)!, { limiter, log, clock })
  return { clock, limiter, log, sent, fetchFor }
}

describe('ratePlan', () => {
  it('is null for a connector without limits, so its requests never touch the limiter', () => {
    expect(ratePlan(connector(), 'c1')).toBeNull()
    expect(ratePlan(connector({}), 'c1')).toBeNull()
  })

  it('puts the application bucket first and always a Connection bucket, which a 429 can park', () => {
    const application = { requests: 6000, windowMs: 60_000 }
    expect(ratePlan(connector({ application }, 'allegro'), 'c1')).toEqual({
      connectorId: 'allegro',
      connectionId: 'c1',
      buckets: [{ key: 'app:allegro', rate: application }, { key: 'conn:c1' }],
      concurrency: null,
    })
    const rate = { requests: 10, windowMs: 1000 }
    expect(ratePlan(connector({ connection: { rate, concurrency: 3 } }), 'c2')).toMatchObject({
      buckets: [{ key: 'conn:c2', rate }],
      concurrency: { key: 'conn:c2', limit: 3 },
    })
  })
})

describe('limitFetch', () => {
  it('sends at once within the budget, and waits for a slot up to 2 s', async () => {
    const { fetchFor, sent, clock, log } = setup({ connection: { rate: { requests: 2, windowMs: 1500 } } })
    const fetch = fetchFor('c1')
    await fetch('https://channel.test/1')
    await fetch('https://channel.test/2')
    expect(clock.slept).toEqual([])
    await fetch('https://channel.test/3')
    expect(clock.slept).toEqual([1500])
    expect(sent).toHaveLength(3)
    expect(log.lines).toEqual([['rate limit wait', { connectorId: 'limited', connectionId: 'c1', waitedMs: 1500 }]])
  })

  it('rejects with RateLimitedError before sending when the slot is further than 2 s away', async () => {
    const { fetchFor, sent, log } = setup({ application: { requests: 1, windowMs: 60_000 } })
    await fetchFor('c1')('https://channel.test/1')
    const error = await fetchFor('c2')('https://channel.test/2').catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(RateLimitedError)
    expect((error as RateLimitedError).retryAfterMs).toBe(60_000)
    expect(sent).toEqual(['https://channel.test/1'])
    expect(log.lines.at(-1)).toEqual([
      'rate limit exceeded',
      { connectorId: 'limited', connectionId: 'c2', reason: 'requests per window', retryAfterMs: 60_000 },
    ])
  })

  it('parks the application and the Connection for the Retry-After of a 429, and still returns the response', async () => {
    let status = 429
    const { fetchFor, sent, log, clock } = setup(
      { application: { requests: 100, windowMs: 60_000 } },
      { respond: () => new Response(null, { status, headers: { 'Retry-After': '30' } }) },
    )
    expect((await fetchFor('c1')('https://channel.test/1')).status).toBe(429)
    expect(log.lines.at(-1)).toEqual(['rate limit parked', { connectorId: 'limited', connectionId: 'c1', parkedMs: 30_000 }])
    status = 204
    // Another Connection of the same connector pauses too: the 429 may be the application's.
    const error = await fetchFor('c2')('https://channel.test/2').catch((reason: unknown) => reason)
    expect((error as RateLimitedError).retryAfterMs).toBe(30_000)
    expect(sent).toHaveLength(1)
    await clock.sleep(30_000)
    expect((await fetchFor('c2')('https://channel.test/3')).status).toBe(204)
  })

  it('parks for 60 s when the 429 does not say, and at most 15 minutes', async () => {
    let headers: Record<string, string> = {}
    const { fetchFor, log } = setup(
      { connection: { concurrency: 5 } },
      { respond: () => new Response(null, { status: 429, headers }) },
    )
    await fetchFor('c1')('https://channel.test/1')
    expect(log.lines.at(-1)?.[1]).toMatchObject({ parkedMs: 60_000 })
    headers = { 'Retry-After': '86400' }
    await expect(fetchFor('c2')('https://channel.test/2')).resolves.toBeInstanceOf(Response)
    expect(log.lines.at(-1)?.[1]).toMatchObject({ parkedMs: 900_000 })
  })

  it('waits for a concurrency lease, and gives up after 2 s with a short retry', async () => {
    const { fetchFor, limiter, clock, sent } = setup({ connection: { concurrency: 1 } })
    const held = await limiter.acquireLease('conn:c1', 1, 60_000)
    const error = await fetchFor('c1')('https://channel.test/1').catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(RateLimitedError)
    expect((error as RateLimitedError).retryAfterMs).toBe(1_000)
    expect(clock.slept.reduce((sum, ms) => sum + ms, 0)).toBe(2_000)
    // Backoff, not a busy loop.
    expect(clock.slept.length).toBeLessThan(15)
    expect(sent).toEqual([])

    await limiter.releaseLease('conn:c1', held!)
    expect((await fetchFor('c1')('https://channel.test/2')).status).toBe(204)
    // Another Connection has its own leases.
    await limiter.acquireLease('conn:c1', 1, 60_000)
    expect((await fetchFor('c2')('https://channel.test/3')).status).toBe(204)
  })

  it('releases the lease when the request fails', async () => {
    const { limiter, log, clock } = setup({ connection: { concurrency: 1 } })
    const failing = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    const fetch = limitFetch(failing, ratePlan(connector({ connection: { concurrency: 1 } }), 'c1')!, { limiter, log, clock })
    await expect(fetch('https://channel.test/1')).rejects.toThrow('fetch failed')
    expect(await limiter.acquireLease('conn:c1', 1, 1_000)).not.toBeNull()
  })

  it('never has more requests in flight per Connection than its concurrency (real clock)', async () => {
    const limiter = createInMemoryRateLimiter()
    const log = recordingLog()
    let inFlight = 0
    let maxInFlight = 0
    const slow = (async () => {
      maxInFlight = Math.max(maxInFlight, ++inFlight)
      await new Promise((resolve) => setTimeout(resolve, 15))
      inFlight--
      return ok()
    }) as typeof fetch
    const fetch = limitFetch(slow, ratePlan(connector({ connection: { concurrency: 2 } }), 'c1')!, { limiter, log })
    const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => fetch(`https://channel.test/${i}`)))
    expect(responses.every((response) => response.status === 204)).toBe(true)
    expect(maxInFlight).toBe(2)
  })
})
