import type { z } from 'zod'
import type { JobRef } from '../jobs'
import type { EnqueueOptions, JobQueue } from '../queue'

export interface RecordedJob {
  name: string
  payload: unknown
  options: EnqueueOptions
}

export interface InMemoryJobQueue extends JobQueue {
  /** Every accepted request, oldest first (coalesced duplicates are not recorded). */
  readonly enqueued: RecordedJob[]
  /** Accepted jobs not run yet, oldest first. */
  readonly waiting: RecordedJob[]
}

/** Records jobs instead of running them; a request is dropped while a job with the same `coalesceKey` waits. */
export function createInMemoryJobQueue(): InMemoryJobQueue {
  const enqueued: RecordedJob[] = []
  const waiting: RecordedJob[] = []
  return {
    enqueued,
    waiting,
    async enqueue<TSchema extends z.ZodType>(job: JobRef<TSchema>, payload: z.input<TSchema>, options: EnqueueOptions = {}) {
      const parsed = job.schema.parse(payload)
      if (options.coalesceKey !== undefined && waiting.some((queued) => queued.options.coalesceKey === options.coalesceKey)) return
      const recorded = { name: job.name, payload: parsed, options }
      enqueued.push(recorded)
      waiting.push(recorded)
    },
    async ping() {},
    async close() {},
  }
}
