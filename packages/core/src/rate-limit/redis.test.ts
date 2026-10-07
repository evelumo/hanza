import { afterAll, describe, expect, it } from 'vitest'
import type { Logger } from '../logger'
import { reachableTestRedis, testRedisPrefix } from '../testing/redis'
import type { RateLimiter } from './limiter'
import { describeRateLimiter } from './limiter-contract'
import { createRedisRateLimiter, UNAVAILABLE_RETRY_AFTER_MS } from './redis'

const redisUrl = await reachableTestRedis()
const silent: Logger = { info() {}, warn() {}, error() {} }
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe.skipIf(!redisUrl)('Redis limiter (REDIS_URL)', () => {
  const { prefix, cleanup } = testRedisPrefix(redisUrl ?? 'redis://unused')
  const limiters: RateLimiter[] = []
  let counter = 0
  afterAll(async () => {
    await Promise.all(limiters.map((limiter) => limiter.close()))
    await cleanup()
  })

  describeRateLimiter('Redis limiter', () => {
    const limiter = createRedisRateLimiter(redisUrl!, { prefix, log: silent })
    limiters.push(limiter)
    return { limiter, advance: sleep, now: () => performance.now(), key: (name) => `${name}-${counter++}`, slack: 5 }
  })

  it('is shared by two instances, as by two workers', async () => {
    const one = createRedisRateLimiter(redisUrl!, { prefix, log: silent })
    const two = createRedisRateLimiter(redisUrl!, { prefix, log: silent })
    limiters.push(one, two)
    const bucket = { key: `shared-${counter++}`, rate: { requests: 2, windowMs: 60_000 } }
    expect((await one.reserve([bucket], 0)).granted).toBe(true)
    expect((await two.reserve([bucket], 0)).granted).toBe(true)
    expect((await one.reserve([bucket], 0)).granted).toBe(false)
    expect((await two.reserve([bucket], 0)).granted).toBe(false)
    await one.park([`parked-${counter}`], 60_000)
    expect((await two.reserve([{ key: `parked-${counter}` }], 0)).granted).toBe(false)
  })

  it('keeps its keys under the prefix and lets them expire', async () => {
    const { Redis } = await import('ioredis')
    const redis = new Redis(redisUrl!)
    try {
      const limiter = createRedisRateLimiter(redisUrl!, { prefix, log: silent })
      limiters.push(limiter)
      const key = `ttl-${counter++}`
      await limiter.reserve([{ key, rate: { requests: 5, windowMs: 10_000 } }], 0)
      await limiter.acquireLease(key, 1, 20_000)
      await limiter.park([key], 30_000)
      for (const [suffix, max] of [['log', 10_000], ['leases', 20_000], ['parked', 30_000]] as const) {
        const ttl = await redis.pttl(`${prefix}:ratelimit:${key}:${suffix}`)
        expect(ttl, suffix).toBeGreaterThan(0)
        expect(ttl, suffix).toBeLessThanOrEqual(max)
      }
    } finally {
      redis.disconnect()
    }
  })
})

describe('Redis limiter without Redis', () => {
  // Nothing listens on port 1.
  const deadRedis = 'redis://127.0.0.1:1'
  const recording = () => {
    const warnings: string[] = []
    const log: Logger = { info() {}, warn: (message) => void warnings.push(message), error() {} }
    return { warnings, log }
  }

  it('fails closed by default: refuses requests and leases for a few seconds, without throwing, and warns once', async () => {
    const { warnings, log } = recording()
    const limiter = createRedisRateLimiter(deadRedis, { prefix: 'unused', log })
    try {
      expect(await limiter.reserve([{ key: 'k', rate: { requests: 1, windowMs: 1000 } }], 0)).toEqual({
        granted: false,
        retryAfterMs: UNAVAILABLE_RETRY_AFTER_MS,
        unavailable: true,
      })
      expect(await limiter.acquireLease('k', 1, 1000)).toEqual({ lease: null, retryAfterMs: UNAVAILABLE_RETRY_AFTER_MS })
      await expect(limiter.releaseLease('k', 'lease')).resolves.toBeUndefined()
      await expect(limiter.park(['k'], 1000)).resolves.toBeUndefined()
      expect(warnings).toEqual(['rate limiter unavailable, requests are refused'])
    } finally {
      await limiter.close()
    }
  })

  it("fails open only when built with whenUnavailable: 'allow'", async () => {
    const { warnings, log } = recording()
    const limiter = createRedisRateLimiter(deadRedis, { prefix: 'unused', log, whenUnavailable: 'allow' })
    try {
      expect(await limiter.reserve([{ key: 'k', rate: { requests: 1, windowMs: 1000 } }], 0)).toEqual({ granted: true, waitMs: 0 })
      expect(await limiter.acquireLease('k', 1, 1000)).toEqual({ lease: expect.any(String) })
      expect(warnings).toEqual(['rate limiter unavailable, requests are not limited'])
    } finally {
      await limiter.close()
    }
  })
})
