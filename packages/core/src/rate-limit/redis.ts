import { randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'
import type { Logger } from '../logger'
import type { Bucket, LeaseResult, RateLimiter, Reservation } from './limiter'

// Every script reads Redis's clock, so workers on machines with skewed clocks share one timeline.
const NOW = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
`

/**
 * KEYS: per bucket, its log (sorted set of request times) then its park key. ARGV: maxWaitMs, a unique member, then
 * per bucket its requests and windowMs (0 and 0 when it limits no rate). Same algorithm as `earliestSlot`: all
 * buckets get the same time, so a request is never recorded earlier in one bucket than it is sent.
 */
const RESERVE = `${NOW}
local maxWait = tonumber(ARGV[1])
local at = now
for i = 1, #KEYS / 2 do
  local log = KEYS[2 * i - 1]
  local parked = tonumber(redis.call('GET', KEYS[2 * i])) or 0
  if parked > at then at = parked end
  local limit = tonumber(ARGV[2 * i + 1])
  local window = tonumber(ARGV[2 * i + 2])
  if limit > 0 then
    redis.call('ZREMRANGEBYSCORE', log, '-inf', now - window)
    local count = redis.call('ZCARD', log)
    if count > 0 then
      local last = tonumber(redis.call('ZRANGE', log, -1, -1, 'WITHSCORES')[2])
      if last > at then at = last end
      if count >= limit then
        local leaving = tonumber(redis.call('ZRANGE', log, count - limit, count - limit, 'WITHSCORES')[2])
        if leaving + window > at then at = leaving + window end
      end
    end
  end
end
local wait = at - now
if wait > maxWait then return {0, wait} end
for i = 1, #KEYS / 2 do
  local limit = tonumber(ARGV[2 * i + 1])
  local window = tonumber(ARGV[2 * i + 2])
  if limit > 0 then
    redis.call('ZADD', KEYS[2 * i - 1], at, ARGV[2])
    redis.call('PEXPIRE', KEYS[2 * i - 1], wait + window)
  end
end
return {1, wait}
`

/** KEYS[1]: lease set (lease id → expiry). ARGV: limit, leaseMs, lease id. */
const ACQUIRE = `${NOW}
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) then return 0 end
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[3])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
return 1
`

/** KEYS: park keys. ARGV[1]: ms. A longer park already set is kept. */
const PARK = `${NOW}
local ms = tonumber(ARGV[1])
for i = 1, #KEYS do
  local current = tonumber(redis.call('GET', KEYS[i])) or 0
  if now + ms > current then redis.call('SET', KEYS[i], now + ms, 'PX', ms) end
end
return 1
`

type Scripts = {
  hanzaRateReserve(...args: Array<string | number>): Promise<[number, number]>
  hanzaRateAcquire(...args: Array<string | number>): Promise<number>
  hanzaRatePark(...args: Array<string | number>): Promise<number>
}

const UNAVAILABLE_LOG_EVERY_MS = 60_000
/** How long a request refused because Redis did not answer waits before its job tries again. */
export const UNAVAILABLE_RETRY_AFTER_MS = 5_000

export interface RedisRateLimiterOptions {
  prefix: string
  log: Logger
  /**
   * What to do when Redis cannot be reached or answers too slowly (2 s). `refuse` (default): refuse the request,
   * so its job retries in `UNAVAILABLE_RETRY_AFTER_MS`; with Redis down the queue cannot finish a job either, and
   * unbudgeted calls risk the whole application's block. `allow`: send it unlimited.
   */
  whenUnavailable?: 'refuse' | 'allow'
}

/**
 * The limiter every worker of an installation shares. Keys are `<prefix>:ratelimit:<bucket>:{log,parked,leases}`;
 * all of them expire when idle. Connects on first use, so a context that never limits a request opens nothing.
 * Assumes one Redis (not a cluster): a reservation's keys may live in different slots.
 */
export function createRedisRateLimiter(redisUrl: string, options: RedisRateLimiterOptions): RateLimiter {
  const allow = options.whenUnavailable === 'allow'
  let client: (Redis & Scripts) | undefined
  const redis = (): Redis & Scripts => {
    if (client) return client
    const created = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2_000, commandTimeout: 2_000 })
    created.on('error', () => {}) // Reported (throttled) where a command fails.
    created.defineCommand('hanzaRateReserve', { lua: RESERVE })
    created.defineCommand('hanzaRateAcquire', { lua: ACQUIRE, numberOfKeys: 1 })
    created.defineCommand('hanzaRatePark', { lua: PARK })
    client = created as Redis & Scripts
    return client
  }
  const key = (bucket: string, suffix: 'log' | 'parked' | 'leases') => `${options.prefix}:ratelimit:${bucket}:${suffix}`

  let lastFailureLog = 0
  async function orElse<T>(operation: string, run: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await run()
    } catch (error) {
      if (Date.now() - lastFailureLog >= UNAVAILABLE_LOG_EVERY_MS) {
        lastFailureLog = Date.now()
        options.log.warn(allow ? 'rate limiter unavailable, requests are not limited' : 'rate limiter unavailable, requests are refused', {
          operation,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return fallback
    }
  }

  return {
    reserve(buckets: Bucket[], maxWaitMs: number): Promise<Reservation> {
      return orElse<Reservation>(
        'reserve',
        async () => {
          const keys = buckets.flatMap((bucket) => [key(bucket.key, 'log'), key(bucket.key, 'parked')])
          const rates = buckets.flatMap((bucket) => [bucket.rate?.requests ?? 0, bucket.rate?.windowMs ?? 0])
          const [granted, ms] = await redis().hanzaRateReserve(keys.length, ...keys, maxWaitMs, randomUUID(), ...rates)
          return granted === 1 ? { granted: true, waitMs: ms } : { granted: false, retryAfterMs: ms }
        },
        allow ? { granted: true, waitMs: 0 } : { granted: false, retryAfterMs: UNAVAILABLE_RETRY_AFTER_MS, unavailable: true },
      )
    },
    acquireLease(bucket, limit, leaseMs): Promise<LeaseResult> {
      return orElse<LeaseResult>(
        'acquireLease',
        async () => {
          const lease = randomUUID()
          return (await redis().hanzaRateAcquire(key(bucket, 'leases'), limit, leaseMs, lease)) === 1 ? { lease } : { lease: null }
        },
        allow ? { lease: randomUUID() } : { lease: null, retryAfterMs: UNAVAILABLE_RETRY_AFTER_MS },
      )
    },
    releaseLease(bucket, lease) {
      return orElse('releaseLease', async () => void (await redis().zrem(key(bucket, 'leases'), lease)), undefined)
    },
    park(buckets, ms) {
      return orElse(
        'park',
        async () => {
          if (buckets.length === 0 || ms <= 0) return
          const keys = buckets.map((bucket) => key(bucket, 'parked'))
          await redis().hanzaRatePark(keys.length, ...keys, Math.ceil(ms))
        },
        undefined,
      )
    },
    async close() {
      if (client) await client.quit().catch(() => client?.disconnect())
    },
  }
}
