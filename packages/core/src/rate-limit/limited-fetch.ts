import { DEFAULT_RETRY_AFTER_MS, RateLimitedError, retryAfterFromHeaders, type AnyConnectorDefinition } from '@hanza/connector-sdk'
import type { Logger } from '../logger'
import type { Bucket, RateLimiter } from './limiter'

/** The longest a request waits for its slot before the job is delayed instead (no busy worker, no busy loop). */
export const RATE_LIMIT_MAX_WAIT_MS = 2_000
/** A concurrency lease outlives the fetch timeout (30 s) and the wait, so only a crashed worker's lease expires. */
export const CONCURRENCY_LEASE_MS = 45_000
/** Retry-after when every concurrency lease stays taken for the whole wait. */
export const CONCURRENCY_RETRY_AFTER_MS = 1_000
/** A 429 parks the budgets at most this long, however long the Channel asks (the job's retry is capped alike). */
export const MAX_PARK_MS = 900_000
const POLL_FIRST_MS = 25
const POLL_MAX_MS = 200

export interface RatePlan {
  connectorId: string
  connectionId: string
  /** Checked and recorded on every request, application bucket first. */
  buckets: Bucket[]
  concurrency: { key: string; limit: number } | null
}

/** Null when the connector declares no limits: its requests then never touch the limiter. */
export function ratePlan(connector: AnyConnectorDefinition, connectionId: string): RatePlan | null {
  const { application, connection } = connector.rateLimits ?? {}
  if (!application && !connection?.rate && !connection?.concurrency) return null
  const connectionKey = `conn:${connectionId}`
  const buckets: Bucket[] = []
  if (application) buckets.push({ key: `app:${connector.id}`, rate: application })
  // Without a rate the Connection's bucket still exists, so a 429 can park it.
  buckets.push(connection?.rate ? { key: connectionKey, rate: connection.rate } : { key: connectionKey })
  const concurrency = connection?.concurrency ? { key: connectionKey, limit: connection.concurrency } : null
  return { connectorId: connector.id, connectionId, buckets, concurrency }
}

/**
 * Refused by Hanza's own limiter before anything was sent. Still a `RateLimitedError` to the connector and the
 * engine (the job waits without using an attempt), but it does not count towards `MAX_RATE_LIMIT_RETRIES`: Hanza
 * throttling itself says nothing about the Channel, and many jobs wake together after a long pause.
 */
export class RequestRefusedError extends RateLimitedError {
  readonly refusedBeforeSending = true

  constructor(message: string, options: { retryAfterMs: number }) {
    super(message, options)
    this.name = 'RequestRefusedError'
  }
}

/** Duck-typed like `classifyConnectorError`, so a second copy of the module still counts. */
export function isRefusedBeforeSending(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { refusedBeforeSending?: unknown }).refusedBeforeSending === true
}

export interface Clock {
  now(): number
  /** Resolves after `ms`, or rejects with the signal's reason once it aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason)
      const onAbort = () => {
        clearTimeout(timer)
        reject(signal!.reason)
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal?.addEventListener('abort', onAbort, { once: true })
    }),
}

/**
 * Wraps `base` so every request fits the plan's budgets: it waits (at most `RATE_LIMIT_MAX_WAIT_MS`, cut short by
 * `init.signal`) for a concurrency lease and a slot, or rejects with `RequestRefusedError` before sending, which
 * delays the job without using an attempt. A 429 parks every bucket of the plan for the Channel's Retry-After (60 s when it gives none),
 * so other jobs and workers pause too; the response still reaches the connector, which reports the rate limit.
 */
export function limitFetch(
  base: typeof fetch,
  plan: RatePlan,
  deps: { limiter: RateLimiter; log: Logger; clock?: Clock; maxWaitMs?: number },
): typeof fetch {
  const { limiter, log } = deps
  const clock = deps.clock ?? realClock
  const maxWaitMs = deps.maxWaitMs ?? RATE_LIMIT_MAX_WAIT_MS
  const fields = { connectorId: plan.connectorId, connectionId: plan.connectionId }

  const refused = (reason: string, retryAfterMs: number) => {
    log.warn('rate limit exceeded', { ...fields, reason, retryAfterMs })
    const text =
      reason === 'rate limiter unavailable'
        ? `Request to connector "${plan.connectorId}" not sent: the rate limiter is unavailable; retrying later`
        : `Request limit of connector "${plan.connectorId}" reached (${reason}); retrying later`
    return new RequestRefusedError(text, { retryAfterMs })
  }

  // Polls with backoff: a lease frees when another request ends, which no script can promise ahead of time.
  async function acquireLease(deadline: number, signal: AbortSignal | undefined): Promise<{ lease: string; waited: boolean }> {
    const { key, limit } = plan.concurrency!
    for (let pause = POLL_FIRST_MS, waited = false; ; pause = Math.min(POLL_MAX_MS, pause * 2), waited = true) {
      const result = await limiter.acquireLease(key, limit, CONCURRENCY_LEASE_MS)
      if (result.lease !== null) return { lease: result.lease, waited }
      if (result.retryAfterMs !== undefined) throw refused('rate limiter unavailable', result.retryAfterMs)
      const left = deadline - clock.now()
      if (left <= 0) throw refused('concurrent requests', CONCURRENCY_RETRY_AFTER_MS)
      await clock.sleep(Math.min(pause, left), signal)
    }
  }

  return async (input, init) => {
    const signal = init?.signal ?? undefined
    signal?.throwIfAborted()
    const started = clock.now()
    const acquired = plan.concurrency ? await acquireLease(started + maxWaitMs, signal) : null
    const lease = acquired?.lease ?? null
    try {
      const reservation = await limiter.reserve(plan.buckets, Math.max(0, started + maxWaitMs - clock.now()))
      if (!reservation.granted) {
        throw refused(reservation.unavailable ? 'rate limiter unavailable' : 'requests per window', reservation.retryAfterMs)
      }
      // An abort here leaves the reserved slot unused: harmless, it only makes later requests a little slower.
      if (reservation.waitMs > 0) await clock.sleep(reservation.waitMs, signal)
      if (acquired?.waited || reservation.waitMs > 0) log.info('rate limit wait', { ...fields, waitedMs: clock.now() - started })

      const response = await base(input, init)
      if (response.status === 429) {
        const parkedMs = Math.min(MAX_PARK_MS, retryAfterFromHeaders(response.headers) ?? DEFAULT_RETRY_AFTER_MS)
        await limiter.park(plan.buckets.map((bucket) => bucket.key), parkedMs)
        log.warn('rate limit parked', { ...fields, parkedMs })
      }
      return response
    } finally {
      if (lease !== null) await limiter.releaseLease(plan.concurrency!.key, lease)
    }
  }
}
