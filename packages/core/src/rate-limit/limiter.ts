import type { RequestRate } from '@hanza/connector-sdk'

/**
 * One budget: a key (e.g. `app:allegro`, `conn:<connectionId>`) and, if it limits the request rate, its rate.
 * A bucket without a rate is still checked for being parked.
 */
export interface Bucket {
  key: string
  rate?: RequestRate
}

/** `unavailable`: refused because the store could not be asked, not because a budget is used up. */
export type Reservation = { granted: true; waitMs: number } | { granted: false; retryAfterMs: number; unavailable?: true }

/** No lease: all are taken (poll again), or, with `retryAfterMs`, the store could not be asked (stop polling). */
export type LeaseResult = { lease: string } | { lease: null; retryAfterMs?: number }

/**
 * Shared request budgets (ADR 0019). Kept engine-neutral like `JobQueue`: Redis in the apps, in memory in tests.
 * Implementations never throw: a store that cannot be reached refuses requests (fail closed) unless built to let
 * them through.
 */
export interface RateLimiter {
  /**
   * Reserves one request in every bucket at one moment: the earliest at which no bucket has more than its
   * `rate.requests` in any window of `rate.windowMs` and none is parked. Granted and recorded only when that moment
   * is at most `maxWaitMs` away (the caller then waits `waitMs`); otherwise nothing is recorded and `retryAfterMs`
   * says how far away it is.
   */
  reserve(buckets: Bucket[], maxWaitMs: number): Promise<Reservation>
  /** Takes one of `limit` leases on `key` for at most `leaseMs`. */
  acquireLease(key: string, limit: number, leaseMs: number): Promise<LeaseResult>
  releaseLease(key: string, lease: string): Promise<void>
  /** No request is reserved on these keys for `ms` from now. Never shortens a longer park. */
  park(keys: string[], ms: number): Promise<void>
  close(): Promise<void>
}

/**
 * The earliest moment a request may go in one bucket, given its recorded request times (ascending, all after
 * `now - windowMs`): never before the last one, so the times stay sorted, and, when the window is full, not before
 * the oldest request that must leave it has left. Windows are half-open, `(t - windowMs, t]`.
 */
export function earliestSlot(times: readonly number[], rate: RequestRate, now: number): number {
  let at = now
  const count = times.length
  if (count > 0) at = Math.max(at, times[count - 1]!)
  if (count >= rate.requests) at = Math.max(at, times[count - rate.requests]! + rate.windowMs)
  return at
}
