import { randomBytes } from 'node:crypto'
import { createDb, type Db } from '@hanza/db'

// For core's own `*.db.test.ts` files; not exported from `@hanza/core/testing`.
// Test files run in parallel against one database, so lock waits are counted
// only for sessions tagged with the test's own `application_name`.

export function uniqueApplicationName(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`
}

export function withApplicationName(url: string, applicationName: string): string {
  const parsed = new URL(url)
  parsed.searchParams.set('application_name', applicationName)
  return parsed.toString()
}

export async function countLockWaits(observer: Db, applicationName: string): Promise<number> {
  const [row] = await observer.$queryRaw<Array<{ waiting: bigint }>>`
    SELECT count(*) AS "waiting" FROM pg_stat_activity
    WHERE datname = current_database() AND application_name = ${applicationName} AND wait_event_type = 'Lock'`
  return Number(row?.waiting ?? 0)
}

/** Polls until `stop()`; returns the most sessions named `applicationName` seen waiting for a lock at once. */
export function watchLockWaits(url: string, applicationName: string): { stop(): Promise<number> } {
  const observer = createDb(url)
  let running = true
  let max = 0
  const loop = (async () => {
    while (running) max = Math.max(max, await countLockWaits(observer, applicationName))
  })()
  return {
    async stop() {
      running = false
      await loop
      await observer.$disconnect()
      return max
    },
  }
}

/** Resolves once a session named `applicationName` waits for a lock; throws after `timeoutMs`. */
export async function untilLockWait(observer: Db, applicationName: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while ((await countLockWaits(observer, applicationName)) === 0) {
    if (Date.now() > deadline) throw new Error(`No session of ${applicationName} waited for a lock within ${timeoutMs} ms`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
