import { hostname } from 'node:os'
import { Redis } from 'ioredis'

// Dev workers of parallel checkouts use the low indexes; a run takes the first free one from the top.
const CANDIDATE_INDEXES = [15, 14, 12, 11, 10, 9]
const CLAIM_KEY = 'hanza:e2e:claim'

// Claims only an empty index, in one step, so two runs (or a run and a dev worker) never share one.
const CLAIM_IF_EMPTY = `
if redis.call('DBSIZE') == 0 then
  redis.call('SET', KEYS[1], ARGV[1])
  return false
end
return redis.call('GET', KEYS[1]) or ''`

const FLUSH_IF_OWNED = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('FLUSHDB')
  if ARGV[2] ~= '' then redis.call('SET', KEYS[1], ARGV[2]) end
  return 1
end
return 0`

interface Claim {
  pid: number
  host: string
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** A claim is stale only when it is provably dead: written on this host by a process that no longer exists. */
export function isStaleClaim(raw: string, here: { host: string; processExists(pid: number): boolean } = { host: hostname(), processExists }): boolean {
  let claim: Partial<Claim>
  try {
    claim = JSON.parse(raw) as Partial<Claim>
  } catch {
    return false
  }
  if (claim.host !== here.host || !Number.isInteger(claim.pid)) return false
  return !here.processExists(claim.pid!)
}

export function withIndex(redisUrl: string, index: number): string {
  const url = new URL(redisUrl)
  url.pathname = `/${index}`
  return url.toString()
}

export interface RedisSlot {
  /** REDIS_URL for the processes of this run. */
  url: string
  index: number
  /** Flushes the index (every BullMQ key of the run and the claim). */
  release(): Promise<void>
}

/** A Redis database index of its own for this run; a claim left by a killed run is taken over. */
export async function claimRedisSlot(redisUrl: string): Promise<RedisSlot> {
  const me = JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() } satisfies Claim & { startedAt: string })
  for (const index of CANDIDATE_INDEXES) {
    const redis = new Redis(withIndex(redisUrl, index), { lazyConnect: true, maxRetriesPerRequest: 1 })
    try {
      await redis.connect()
      const owner = (await redis.eval(CLAIM_IF_EMPTY, 1, CLAIM_KEY, me)) as string | null
      const claimed = owner === null || (owner !== '' && isStaleClaim(owner) && (await redis.eval(FLUSH_IF_OWNED, 1, CLAIM_KEY, owner, me)) === 1)
      if (!claimed) continue
      const url = withIndex(redisUrl, index)
      return {
        url,
        index,
        async release() {
          const client = new Redis(url, { maxRetriesPerRequest: 1 })
          try {
            await client.eval(FLUSH_IF_OWNED, 1, CLAIM_KEY, me, '')
          } finally {
            client.disconnect()
          }
        },
      }
    } finally {
      redis.disconnect()
    }
  }
  const server = new URL(redisUrl).host
  throw new Error(`No free Redis database among indexes ${CANDIDATE_INDEXES.join(', ')} on ${server}; empty one with FLUSHDB`)
}
