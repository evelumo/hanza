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
}

export interface JobDefinition<TSchema extends z.ZodType = z.ZodType> extends JobRef<TSchema> {
  handler: (ctx: Context, payload: z.infer<TSchema>, run: JobRunInfo) => Promise<void>
}

export function defineJob<TSchema extends z.ZodType>(job: JobDefinition<TSchema>): JobDefinition<TSchema> {
  return job
}

/** Retry after `delayMs` without consuming an attempt (rate limits). */
export class RetryLaterError extends Error {
  override readonly name = 'RetryLaterError'

  constructor(
    readonly delayMs: number,
    message: string,
  ) {
    super(message)
  }
}

/** Fail now, no further attempts. */
export class PermanentJobError extends Error {
  override readonly name = 'PermanentJobError'
}
