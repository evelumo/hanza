import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { dropTestDatabase } from '@hanza/db/testing'
import { Redis } from 'ioredis'
import { killRunProcesses, processStartTime } from './run-processes'

// Everything a run owns is named after its id, and recorded here before it is created, so a later
// run can clean up after a runner that was killed (SIGKILL, a crash, a closed laptop lid).
const RUNS_KEY = 'hanza-e2e:runs'
const RUN_ID = /^[0-9a-f]{12}$/
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
export const ALLOW_REMOTE_REDIS = 'HANZA_E2E_ALLOW_REMOTE_REDIS'

export interface RunRecord {
  runId: string
  host: string
  /** The runner's PID and start time: both must match for the runner to count as alive. */
  pid: number
  startedAt: string
  /** BullMQ key prefix of the run; the run's keys are `<prefix>:*`. */
  queuePrefix: string
  /** The throwaway database and the server (host:port) it lives on. */
  database: { name: string; server: string }
  /** For people reading the record; recovery finds processes by the run id on their command line. */
  ports: number[]
  services: Array<{ name: string; pid: number | undefined }>
}

export function newRunId(): string {
  return randomBytes(6).toString('hex')
}

export function namesFor(runId: string): { queuePrefix: string; database: string } {
  if (!RUN_ID.test(runId)) throw new Error(`Invalid run id "${runId}"`)
  return { queuePrefix: `hanza-e2e-${runId}`, database: `hanza_e2e_${runId}` }
}

export function serverOf(url: string): string {
  const parsed = new URL(url)
  return `${parsed.hostname}:${parsed.port || (parsed.protocol.startsWith('postgres') ? '5432' : '6379')}`
}

/** The runs use a Redis they share with nobody else's data only by agreement; a remote one needs an explicit opt-in. */
export function assertRedisAllowed(redisUrl: string, env: NodeJS.ProcessEnv = process.env): void {
  const host = new URL(redisUrl).hostname
  if (LOOPBACK.has(host) || env[ALLOW_REMOTE_REDIS] === '1') return
  throw new Error(`REDIS_URL points to ${host}, not this machine; set ${ALLOW_REMOTE_REDIS}=1 to run the e2e suite against it anyway`)
}

/** A run is dead when it was started on this host and its runner (same PID, same start time) is gone. Other hosts' runs are never touched. */
export function isDeadRun(record: RunRecord, here: { host: string; startTimeOf(pid: number): string | null }): boolean {
  if (record.host !== here.host) return false
  return here.startTimeOf(record.pid) !== record.startedAt
}

export function parseRunRecord(raw: string): RunRecord | null {
  try {
    const record = JSON.parse(raw) as RunRecord
    namesFor(record.runId)
    return record
  } catch {
    return null
  }
}

export class RunRegistry {
  private constructor(
    private readonly redis: Redis,
    private readonly adminUrl: string,
  ) {}

  static async connect(redisUrl: string, adminUrl: string): Promise<RunRegistry> {
    assertRedisAllowed(redisUrl)
    const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 })
    try {
      await redis.connect()
    } catch (error) {
      redis.disconnect()
      throw new Error(`Redis at ${serverOf(redisUrl)} is not reachable (\`pnpm infra:up\`)`, { cause: error })
    }
    return new RunRegistry(redis, adminUrl)
  }

  async save(record: RunRecord): Promise<void> {
    await this.redis.hset(RUNS_KEY, record.runId, JSON.stringify(record))
  }

  /** Deletes only the run's own queue keys (`<prefix>:*`), never anything else in the database. */
  async deleteQueueKeys(record: RunRecord): Promise<number> {
    const { queuePrefix } = namesFor(record.runId)
    let deleted = 0
    let cursor = '0'
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${queuePrefix}:*`, 'COUNT', 500)
      cursor = next
      const own = keys.filter((key) => key.startsWith(`${queuePrefix}:`))
      if (own.length > 0) deleted += await this.redis.unlink(...own)
    } while (cursor !== '0')
    return deleted
  }

  async dropDatabase(record: RunRecord): Promise<void> {
    const { database } = namesFor(record.runId)
    if (record.database.name !== database) throw new Error(`Run ${record.runId} names database "${record.database.name}"; refusing to drop it`)
    if (record.database.server !== serverOf(this.adminUrl)) {
      throw new Error(`Run ${record.runId} used the database server ${record.database.server}, not ${serverOf(this.adminUrl)}; drop "${database}" there by hand`)
    }
    await dropTestDatabase(this.adminUrl, database)
  }

  /** Processes, database, queue keys, then the record itself (kept if a step fails, so a later run retries). */
  async destroy(record: RunRecord, options: { killProcesses: boolean }): Promise<void> {
    if (options.killProcesses) await killRunProcesses(record.runId)
    await this.dropDatabase(record)
    await this.deleteQueueKeys(record)
    await this.redis.hdel(RUNS_KEY, record.runId)
  }

  /** Cleans up after every dead run of this host; returns the ids it recovered. */
  async recoverDeadRuns(log: (message: string) => void): Promise<string[]> {
    const here = { host: hostname(), startTimeOf: processStartTime }
    const recovered: string[] = []
    for (const [runId, raw] of Object.entries(await this.redis.hgetall(RUNS_KEY))) {
      const record = parseRunRecord(raw)
      if (!record || record.runId !== runId) {
        log(`ignoring an unreadable run record "${runId}" in ${RUNS_KEY}`)
        continue
      }
      if (!isDeadRun(record, here)) continue
      log(`cleaning up after dead run ${runId} (runner PID ${record.pid} is gone)`)
      try {
        await this.destroy(record, { killProcesses: true })
        recovered.push(runId)
      } catch (error) {
        // Its prefix and database are its own, so it cannot disturb this run; the next run retries.
        log(`could not clean up after run ${runId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return recovered
  }

  close(): void {
    this.redis.disconnect()
  }
}
