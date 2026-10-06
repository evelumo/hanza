import { randomUUID } from 'node:crypto'
import { earliestSlot, type RateLimiter } from './limiter'

/** The algorithm of the Redis scripts, for one process: tests, and the test context. */
export function createInMemoryRateLimiter(options: { now?: () => number } = {}): RateLimiter {
  const now = options.now ?? Date.now
  const logs = new Map<string, number[]>()
  const parkedUntil = new Map<string, number>()
  const leases = new Map<string, Map<string, number>>()

  return {
    async reserve(buckets, maxWaitMs) {
      const current = now()
      let at = current
      for (const bucket of buckets) {
        at = Math.max(at, parkedUntil.get(bucket.key) ?? 0)
        if (!bucket.rate) continue
        const { windowMs } = bucket.rate
        const times = (logs.get(bucket.key) ?? []).filter((time) => time > current - windowMs)
        logs.set(bucket.key, times)
        at = Math.max(at, earliestSlot(times, bucket.rate, current))
      }
      const waitMs = at - current
      if (waitMs > maxWaitMs) return { granted: false, retryAfterMs: waitMs }
      for (const bucket of buckets) if (bucket.rate) logs.get(bucket.key)!.push(at)
      return { granted: true, waitMs }
    },
    async acquireLease(key, limit, leaseMs) {
      const current = now()
      const held = leases.get(key) ?? new Map<string, number>()
      for (const [lease, expiresAt] of held) if (expiresAt <= current) held.delete(lease)
      leases.set(key, held)
      if (held.size >= limit) return null
      const lease = randomUUID()
      held.set(lease, current + leaseMs)
      return lease
    },
    async releaseLease(key, lease) {
      leases.get(key)?.delete(lease)
    },
    async park(keys, ms) {
      const until = now() + ms
      for (const key of keys) parkedUntil.set(key, Math.max(parkedUntil.get(key) ?? 0, until))
    },
    async close() {},
  }
}
