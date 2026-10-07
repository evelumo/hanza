import { describe, expect, it } from 'vitest'
import type { LeaseResult, RateLimiter, Reservation } from './limiter'

// Shared by the in-memory and the Redis limiter tests: both must behave the same. Redis runs on its own, real
// clock, and a busy machine (the whole `pnpm test` at once) can pause this process between two calls, so a wait
// is checked against the time that really passed: never more than expected, and never less than expected minus the
// time elapsed since the requests it waits for were made (`elapsed()`), minus `slack` for millisecond rounding.

export interface LimiterHarness {
  limiter: RateLimiter
  /** Lets `ms` pass: a fake clock moves, a real one is slept on. */
  advance(ms: number): Promise<void>
  /** The harness's clock in ms: fake, or `performance.now()`. */
  now(): number
  /** A key no other test uses. */
  key(name: string): string
  /** Rounding allowance in ms: 0 for a fake clock. */
  slack: number
}

const WINDOW = 300

function waitOf(reservation: Reservation): number {
  if (!reservation.granted) throw new Error(`expected a grant, got retryAfterMs ${reservation.retryAfterMs}`)
  return reservation.waitMs
}

function retryOf(reservation: Reservation): number {
  if (reservation.granted) throw new Error(`expected a refusal, got waitMs ${reservation.waitMs}`)
  return reservation.retryAfterMs
}

function leaseOf(result: LeaseResult): string | null {
  return result.lease
}

/** Checks `ms` lies in [expected - time passed since `since` - slack, expected]. */
function within(h: LimiterHarness, since: number) {
  return (ms: number, expected: number) => {
    expect(ms).toBeLessThanOrEqual(expected)
    expect(ms).toBeGreaterThanOrEqual(expected - (h.now() - since) - h.slack)
  }
}

export function describeRateLimiter(name: string, setup: () => LimiterHarness): void {
  describe(`${name}: reservations`, () => {
    it('grants a full window at once, then makes the next request wait for the oldest to leave', async () => {
      const h = setup()
      const bucket = { key: h.key('a'), rate: { requests: 3, windowMs: WINDOW } }
      const since = h.now()
      for (let i = 0; i < 3; i++) expect(waitOf(await h.limiter.reserve([bucket], 0))).toBe(0)
      within(h, since)(waitOf(await h.limiter.reserve([bucket], 10 * WINDOW)), WINDOW)
    })

    it('records nothing when the slot is further away than maxWaitMs', async () => {
      const h = setup()
      const bucket = { key: h.key('b'), rate: { requests: 1, windowMs: WINDOW } }
      const since = h.now()
      expect(waitOf(await h.limiter.reserve([bucket], 0))).toBe(0)
      for (let i = 0; i < 3; i++) {
        const retry = retryOf(await h.limiter.reserve([bucket], 0))
        within(h, since)(retry, WINDOW)
      }
      // The refusals took no slot: the next grant is still one window after the first request.
      within(h, since)(waitOf(await h.limiter.reserve([bucket], 10 * WINDOW)), WINDOW)
    })

    it('spaces reservations so that no window ever holds more than the limit', async () => {
      const h = setup()
      const bucket = { key: h.key('c'), rate: { requests: 2, windowMs: WINDOW } }
      const since = h.now()
      const expected = [0, 0, WINDOW, WINDOW, 2 * WINDOW, 2 * WINDOW]
      for (const wait of expected) within(h, since)(waitOf(await h.limiter.reserve([bucket], 10 * WINDOW)), wait)
    })

    it('shares an application bucket between Connections and holds both buckets to one time', async () => {
      const h = setup()
      const app = { key: h.key('app'), rate: { requests: 3, windowMs: WINDOW } }
      const connA = { key: h.key('conn-a'), rate: { requests: 2, windowMs: WINDOW } }
      const connB = { key: h.key('conn-b'), rate: { requests: 2, windowMs: WINDOW } }
      const since = h.now()
      expect(waitOf(await h.limiter.reserve([app, connA], 0))).toBe(0)
      expect(waitOf(await h.limiter.reserve([app, connA], 0))).toBe(0)
      // Connection A is full, B is not, but the application has room for one more only.
      within(h, since)(retryOf(await h.limiter.reserve([app, connA], 0)), WINDOW)
      expect(waitOf(await h.limiter.reserve([app, connB], 0))).toBe(0)
      within(h, since)(retryOf(await h.limiter.reserve([app, connB], 0)), WINDOW)
    })

    it('recovers the budget once the window has passed', async () => {
      const h = setup()
      const bucket = { key: h.key('d'), rate: { requests: 2, windowMs: WINDOW } }
      await h.limiter.reserve([bucket], 0)
      await h.limiter.reserve([bucket], 0)
      expect((await h.limiter.reserve([bucket], 0)).granted).toBe(false)
      await h.advance(WINDOW + h.slack)
      expect(waitOf(await h.limiter.reserve([bucket], 0))).toBe(0)
      expect(waitOf(await h.limiter.reserve([bucket], 0))).toBe(0)
    })
  })

  describe(`${name}: parking`, () => {
    it('holds every request on a parked key, with or without a rate, and never shortens a park', async () => {
      const h = setup()
      const plain = { key: h.key('parked') }
      const rated = { key: h.key('parked-rated'), rate: { requests: 100, windowMs: WINDOW } }
      const since = h.now()
      await h.limiter.park([plain.key, rated.key], WINDOW)
      await h.limiter.park([plain.key], 1)
      for (const bucket of [plain, rated]) within(h, since)(retryOf(await h.limiter.reserve([bucket], 0)), WINDOW)
      // A wait that covers the park is granted, at its end.
      within(h, since)(waitOf(await h.limiter.reserve([plain], 10 * WINDOW)), WINDOW)
      await h.advance(WINDOW + h.slack)
      expect(waitOf(await h.limiter.reserve([rated], 0))).toBe(0)
    })
  })

  describe(`${name}: leases`, () => {
    it('hands out at most `limit` leases and takes one back on release', async () => {
      const { limiter, key } = setup()
      const k = key('leases')
      const first = leaseOf(await limiter.acquireLease(k, 2, 10_000))
      const second = leaseOf(await limiter.acquireLease(k, 2, 10_000))
      expect(first).not.toBeNull()
      expect(second).not.toBeNull()
      expect(first).not.toBe(second)
      // All taken: no lease, and no retry-after (the caller polls).
      expect(await limiter.acquireLease(k, 2, 10_000)).toEqual({ lease: null })
      await limiter.releaseLease(k, first!)
      expect(leaseOf(await limiter.acquireLease(k, 2, 10_000))).not.toBeNull()
    })

    it('lets a lease that was never released expire', async () => {
      const { limiter, key, advance, slack } = setup()
      const k = key('expiring')
      expect(leaseOf(await limiter.acquireLease(k, 1, WINDOW))).not.toBeNull()
      expect(leaseOf(await limiter.acquireLease(k, 1, WINDOW))).toBeNull()
      await advance(WINDOW + slack)
      expect(leaseOf(await limiter.acquireLease(k, 1, WINDOW))).not.toBeNull()
    })
  })
}
