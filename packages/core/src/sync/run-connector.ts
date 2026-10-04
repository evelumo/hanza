import { classifyConnectorError } from '@hanza/connector-sdk'
import type { SyncStream } from '@hanza/db'
import { failSyncRun } from '../connections/sync-state'
import type { Context } from '../context'
import { PermanentJobError, RetryLaterError, type JobRunInfo } from '../jobs'

export interface RunScope {
  organizationId: string
  connectionId: string
  stream: SyncStream
  run: JobRunInfo
}

/** A rate-limited retry does not use an attempt, so a zero or past Retry-After must not become a hot loop. */
export const RETRY_LATER_MIN_MS = 1_000
export const RETRY_LATER_MAX_MS = 900_000

export function retryLaterDelay(retryAfterMs: number | null): number {
  const wanted = retryAfterMs !== null && Number.isFinite(retryAfterMs) ? retryAfterMs : RETRY_LATER_MIN_MS
  return Math.min(RETRY_LATER_MAX_MS, Math.max(RETRY_LATER_MIN_MS, wanted))
}

/**
 * Runs one connector call and turns its failure into the job outcome, Connection health and
 * `sync_state` of spec §5.4. A success is left to the caller, which finishes the run once.
 */
export async function runConnectorCall<T>(ctx: Context, scope: RunScope, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    const { kind, retryAfterMs, message } = classifyConnectorError(error)
    const { organizationId, connectionId, stream, run } = scope
    const fail = (health: 'failing' | 'auth_expired' | null) =>
      failSyncRun(ctx, organizationId, connectionId, stream, { kind, message, health })

    switch (kind) {
      case 'auth_expired':
        await fail('auth_expired')
        throw new PermanentJobError(message)
      case 'rate_limited':
        await fail(null)
        throw new RetryLaterError(retryLaterDelay(retryAfterMs), message)
      case 'transient':
        await fail(run.attempt >= run.maxAttempts ? 'failing' : null)
        throw error
      case 'permanent':
        await fail('failing')
        throw new PermanentJobError(message)
    }
  }
}
