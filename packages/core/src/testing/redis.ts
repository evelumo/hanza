import { randomBytes } from 'node:crypto'
import { Redis } from 'ioredis'

/**
 * `REDIS_URL` when a Redis answers there within a second, else null: Redis-backed tests then skip, as database
 * tests do without `HANZA_TEST_DATABASE_URL` (CI has no Redis). Use with top-level await before `describe.skipIf`.
 */
export async function reachableTestRedis(url = process.env.REDIS_URL): Promise<string | null> {
  if (!url) return null
  const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 1_000, retryStrategy: () => null })
  redis.on('error', () => {})
  try {
    await redis.connect()
    await redis.ping()
    return url
  } catch {
    return null
  } finally {
    redis.disconnect()
  }
}

/** A key prefix of its own for one test file, and a way to delete every key under it afterwards. */
export function testRedisPrefix(url: string): { prefix: string; cleanup(): Promise<void> } {
  const prefix = `hanza-test-${randomBytes(6).toString('hex')}`
  return {
    prefix,
    async cleanup() {
      const redis = new Redis(url, { maxRetriesPerRequest: 1 })
      try {
        let cursor = '0'
        do {
          const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 500)
          cursor = next
          if (keys.length > 0) await redis.unlink(...keys)
        } while (cursor !== '0')
      } finally {
        redis.disconnect()
      }
    },
  }
}
