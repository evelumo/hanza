import type { z } from 'zod'
import type { Context } from '../context'
import { PermanentJobError, RetryLaterError, type JobDefinition, type JobRef } from '../jobs'
import type { EnqueueOptions, JobQueue, ScheduleOptions } from '../queue'

const MAX_ATTEMPTS = 5

export interface RecordedJob {
  name: string
  payload: unknown
  options: EnqueueOptions
}

export interface RecordedSchedule {
  scheduleId: string
  name: string
  payload: unknown
  everyMs: number
}

export interface FailedJob {
  name: string
  payload: unknown
  attempts: number
  error: unknown
}

export interface DrainResult {
  /** Handler runs, retries included. */
  ran: number
  /** Jobs that failed for good during this drain. */
  failed: FailedJob[]
}

export interface InMemoryJobQueue extends JobQueue {
  /** Every accepted request, oldest first (coalesced duplicates are not recorded). */
  readonly enqueued: RecordedJob[]
  /** Accepted jobs not run yet, oldest first. */
  readonly waiting: RecordedJob[]
  /** Current schedules, one per scheduleId. */
  readonly schedules: RecordedSchedule[]
  /** Every job that failed for good, across drains. */
  readonly failed: FailedJob[]
  /**
   * Runs waiting jobs FIFO, including the ones they enqueue, until none wait or `maxJobs` handler runs happened.
   * `RetryLaterError` re-queues at the end without using an attempt (counted in `retriedLater` until an attempt is
   * used); other errors retry at once up to 5 attempts;
   * `PermanentJobError` fails at once.
   */
  drain(ctx: Context, jobs: JobDefinition[], options?: { maxJobs?: number }): Promise<DrainResult>
}

/** Records jobs and runs them only on `drain`; a request is dropped while a job with the same `coalesceKey` waits. */
export function createInMemoryJobQueue(): InMemoryJobQueue {
  const enqueued: RecordedJob[] = []
  const waiting: RecordedJob[] = []
  const schedules: RecordedSchedule[] = []
  const failed: FailedJob[] = []
  const attempts = new WeakMap<RecordedJob, number>()
  const retriedLater = new WeakMap<RecordedJob, number>()

  const isWaiting = (coalesceKey: string | undefined) =>
    coalesceKey !== undefined && waiting.some((queued) => queued.options.coalesceKey === coalesceKey)

  return {
    enqueued,
    waiting,
    schedules,
    failed,
    async enqueue<TSchema extends z.ZodType>(job: JobRef<TSchema>, payload: z.input<TSchema>, options: EnqueueOptions = {}) {
      const parsed = job.schema.parse(payload)
      if (isWaiting(options.coalesceKey)) return
      const recorded = { name: job.name, payload: parsed, options }
      enqueued.push(recorded)
      waiting.push(recorded)
    },
    async schedule<TSchema extends z.ZodType>(scheduleId: string, job: JobRef<TSchema>, payload: z.input<TSchema>, options: ScheduleOptions) {
      const recorded = { scheduleId, name: job.name, payload: job.schema.parse(payload), everyMs: options.everyMs }
      const index = schedules.findIndex((schedule) => schedule.scheduleId === scheduleId)
      if (index === -1) schedules.push(recorded)
      else schedules[index] = recorded
    },
    async ping() {},
    async close() {},
    async drain(ctx, jobs, { maxJobs = 200 } = {}) {
      const result: DrainResult = { ran: 0, failed: [] }
      const fail = (job: RecordedJob, error: unknown) => {
        const entry = { name: job.name, payload: job.payload, attempts: attempts.get(job) ?? 0, error }
        result.failed.push(entry)
        failed.push(entry)
      }

      while (waiting.length > 0 && result.ran < maxJobs) {
        const job = waiting.shift()!
        const definition = jobs.find((candidate) => candidate.name === job.name)
        if (!definition) {
          fail(job, new Error(`Unknown job "${job.name}"`))
          continue
        }
        const attempt = (attempts.get(job) ?? 0) + 1
        result.ran++
        try {
          await definition.handler(ctx, definition.schema.parse(job.payload), {
            attempt,
            maxAttempts: MAX_ATTEMPTS,
            retriedLater: retriedLater.get(job) ?? 0,
          })
        } catch (error) {
          if (error instanceof RetryLaterError) {
            retriedLater.set(job, (retriedLater.get(job) ?? 0) + 1)
            // At most one waiting job per coalesce key; payloads only identify the work, so either one will do.
            if (!isWaiting(job.options.coalesceKey)) waiting.push(job)
            continue
          }
          attempts.set(job, attempt)
          retriedLater.delete(job)
          if (error instanceof PermanentJobError || attempt >= MAX_ATTEMPTS) fail(job, error)
          else waiting.unshift(job)
        }
      }
      return result
    },
  }
}
