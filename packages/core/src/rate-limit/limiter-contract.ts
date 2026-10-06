import { describe, expect, it } from 'vitest'
import type { RateLimiter, Reservation } from './limiter'

// Shared by the in-memory and the Redis limiter tests: both must behave the same. Times are asserted with
// `slack` because Redis runs on its own (real) clock.

export interface LimiterHarness {
  limiter: RateLimiter
  /** Lets `ms` pass: a fake clock moves, a real one is slept on. */
  advance(ms: number): Promise<void>
  /** A key no other test uses. */
  key(name: string): string
  slack: number
}

const WINDOW = 300

function waitOf(reservation: Reservation): number {
  if (!reservation.granted) throw new Error(`expected a grant, got retryAfterMs ${reservation.retryAfterMs}`)
  return reservation.waitMs
}

export function describeRateLimiter(name: string, setup: () => LimiterHarness): void {
  describe(`${name}: reservations`, () => {
    it('grants a full window at once, then makes the next request wait for the oldest to leave', async () => {
      const { limiter, key, slack } = setup()
      const bucket = { key: key('a'), rate: { requests: 3, windowMs: WINDOW } }
      for (let i = 0; i < 3; i++) expect(waitOf(await limiter.reserve([bucket], 0))).toBeLessThanOrEqual(slack)
      const next = waitOf(await limiter.reserve([bucket], 10 * WINDOW))
      expect(next).toBeGreaterThanOrEqual(WINDOW - slack)
      expect(next).toBeLessThanOrEqual(WINDOW)
    })

    it('records nothing when the slot is further away than maxWaitMs', async () => {
      const { limiter, key, slack } = setup()
      const bucket = { key: key('b'), rate: { requests: 1, windowMs: WINDOW } }
      expect(waitOf(await limiter.reserve([bucket], 0))).toBeLessThanOrEqual(slack)
      for (let i = 0; i < 3; i++) {
        const denied = await limiter.reserve([bucket], WINDOW / 2)
        expect(denied.granted).toBe(false)
        if (!denied.granted) expect(denied.retryAfterMs).toBeGreaterThanOrEqual(WINDOW - slack)
      }
      // The denials took no slot: the next grant is still one window after the first request.
      expect(waitOf(await limiter.reserve([bucket], 10 * WINDOW))).toBeLessThanOrEqual(WINDOW)
    })

    it('spaces reservations so that no window ever holds more than the limit', async () => {
      const { limiter, key, slack } = setup()
      const bucket = { key: key('c'), rate: { requests: 2, windowMs: WINDOW } }
      const waits: number[] = []
      for (let i = 0; i < 6; i++) waits.push(waitOf(await limiter.reserve([bucket], 10 * WINDOW)))
      const expected = [0, 0, WINDOW, WINDOW, 2 * WINDOW, 2 * WINDOW]
      waits.forEach((wait, i) => {
        expect(wait).toBeGreaterThanOrEqual(expected[i]! - slack)
        expect(wait).toBeLessThanOrEqual(expected[i]!)
      })
    })

    it('shares an application bucket between Connections and holds both buckets to one time', async () => {
      const { limiter, key, slack } = setup()
      const app = { key: key('app'), rate: { requests: 3, windowMs: WINDOW } }
      const connA = { key: key('conn-a'), rate: { requests: 2, windowMs: WINDOW } }
      const connB = { key: key('conn-b'), rate: { requests: 2, windowMs: WINDOW } }
      expect(waitOf(await limiter.reserve([app, connA], 0))).toBeLessThanOrEqual(slack)
      expect(waitOf(await limiter.reserve([app, connA], 0))).toBeLessThanOrEqual(slack)
      // Connection A is full, B is not, but the application has room for one more only.
      expect((await limiter.reserve([app, connA], 0)).granted).toBe(false)
      expect(waitOf(await limiter.reserve([app, connB], 0))).toBeLessThanOrEqual(slack)
      const deniedB = await limiter.reserve([app, connB], 0)
      expect(deniedB.granted).toBe(false)
      if (!deniedB.granted) expect(deniedB.retryAfterMs).toBeGreaterThanOrEqual(WINDOW - slack)
    })

    it('recovers the budget once the window has passed', async () => {
      const { limiter, key, slack, advance } = setup()
      const bucket = { key: key('d'), rate: { requests: 2, windowMs: WINDOW } }
      await limiter.reserve([bucket], 0)
      await limiter.reserve([bucket], 0)
      expect((await limiter.reserve([bucket], 0)).granted).toBe(false)
      await advance(WINDOW + slack)
      expect(waitOf(await limiter.reserve([bucket], 0))).toBe(0)
      expect(waitOf(await limiter.reserve([bucket], 0))).toBe(0)
    })
  })

  describe(`${name}: parking`, () => {
    it('holds every request on a parked key, with or without a rate, and never shortens a park', async () => {
      const { limiter, key, slack, advance } = setup()
      const plain = { key: key('parked') }
      const rated = { key: key('parked-rated'), rate: { requests: 100, windowMs: WINDOW } }
      await limiter.park([plain.key, rated.key], WINDOW)
      await limiter.park([plain.key], 1)
      for (const bucket of [plain, rated]) {
        const denied = await limiter.reserve([bucket], 0)
        expect(denied.granted).toBe(false)
        if (!denied.granted) expect(denied.retryAfterMs).toBeGreaterThanOrEqual(WINDOW - slack)
      }
      // A wait that covers the park is granted, at its end.
      expect(waitOf(await limiter.reserve([plain], 10 * WINDOW))).toBeGreaterThanOrEqual(WINDOW - slack)
      await advance(WINDOW + slack)
      expect(waitOf(await limiter.reserve([rated], 0))).toBe(0)
    })
  })

  describe(`${name}: leases`, () => {
    it('hands out at most `limit` leases and takes one back on release', async () => {
      const { limiter, key } = setup()
      const k = key('leases')
      const first = await limiter.acquireLease(k, 2, 10_000)
      const second = await limiter.acquireLease(k, 2, 10_000)
      expect(first).not.toBeNull()
      expect(second).not.toBeNull()
      expect(first).not.toBe(second)
      expect(await limiter.acquireLease(k, 2, 10_000)).toBeNull()
      await limiter.releaseLease(k, first!)
      expect(await limiter.acquireLease(k, 2, 10_000)).not.toBeNull()
    })

    it('lets a lease that was never released expire', async () => {
      const { limiter, key, advance, slack } = setup()
      const k = key('expiring')
      expect(await limiter.acquireLease(k, 1, WINDOW)).not.toBeNull()
      expect(await limiter.acquireLease(k, 1, WINDOW)).toBeNull()
      await advance(WINDOW + slack)
      expect(await limiter.acquireLease(k, 1, WINDOW)).not.toBeNull()
    })
  })
}
