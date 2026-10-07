import type { z } from 'zod'
import type { Context } from './context'

/** Names a job and its payload; enough to enqueue it without importing the handler. */
export interface JobRef<TSchema extends z.ZodType = z.ZodType> {
  name: string
  schema: TSchema
}

/** `attempt` is 1-based. */
export interface JobRunInfo {
  attempt: number
  maxAttempts: number
  /** Counted `RetryLaterError` retries of this attempt so far (they use no attempt); 0 on the first run of each attempt. */
  retriedLater: number
}

export interface JobDefinition<TSchema extends z.ZodType = z.ZodType> extends JobRef<TSchema> {
  handler: (ctx: Context, payload: z.infer<TSchema>, run: JobRunInfo) => Promise<void>
}

export function defineJob<TSchema extends z.ZodType>(job: JobDefinition<TSchema>): JobDefinition<TSchema> {
  return job
}

/**
 * Retry after `delayMs` without consuming an attempt (rate limits). `counted: false` keeps the retry out of
 * `JobRunInfo.retriedLater`, for waits that say nothing about the outside world (Hanza throttling itself).
 */
export class RetryLaterError extends Error {
  override readonly name = 'RetryLaterError'
  readonly counted: boolean

  constructor(
    readonly delayMs: number,
    message: string,
    options: { counted?: boolean } = {},
  ) {
    super(message)
    this.counted = options.counted ?? true
  }
}

/** Fail now, no further attempts. */
export class PermanentJobError extends Error {
  override readonly name = 'PermanentJobError'
}
