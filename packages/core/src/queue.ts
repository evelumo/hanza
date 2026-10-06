import { DelayedError, Queue, UnrecoverableError, Worker, type ConnectionOptions, type Job, type JobsOptions } from 'bullmq'
import type { z } from 'zod'
import type { Context } from './context'
import { describeFailure } from './describe-failure'
import { PermanentJobError, RetryLaterError, type JobDefinition, type JobRef } from './jobs'

export const QUEUE_NAME = 'hanza'

export interface EnqueueOptions {
  /** Jobs with the same key are coalesced: at most one waiting and one running; while one runs, the newest request runs after it. */
  coalesceKey?: string
  delayMs?: number
}

export interface ScheduleOptions {
  everyMs: number
}

/**
 * The only queue API the rest of the code sees. BullMQ stays behind it so the
 * engine can be swapped (e.g. for Temporal) without touching callers.
 */
export interface JobQueue {
  enqueue<TSchema extends z.ZodType>(job: JobRef<TSchema>, payload: z.input<TSchema>, options?: EnqueueOptions): Promise<void>
  /** Create or update a repeating job; idempotent per scheduleId. */
  schedule<TSchema extends z.ZodType>(scheduleId: string, job: JobRef<TSchema>, payload: z.input<TSchema>, options: ScheduleOptions): Promise<void>
  ping(): Promise<void>
  close(): Promise<void>
}

export interface QueueWorker {
  close(): Promise<void>
}

export function redisConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl)
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : undefined,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    // Required by BullMQ for blocking connections.
    maxRetriesPerRequest: null,
  }
}

export function bullJobOptions(options: EnqueueOptions = {}): JobsOptions {
  const jobOptions: JobsOptions = {}
  if (options.coalesceKey !== undefined) {
    jobOptions.deduplication = { id: options.coalesceKey, keepLastIfActive: true }
  }
  if (options.delayMs !== undefined) jobOptions.delay = options.delayMs
  return jobOptions
}

export function createJobQueue(redisUrl: string, options: { prefix?: string } = {}): JobQueue {
  // Created on first use, so importing the context never opens a connection.
  let instance: Queue | undefined
  const queue = () =>
    (instance ??= new Queue(QUEUE_NAME, {
      connection: redisConnection(redisUrl),
      prefix: options.prefix,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 5_000 },
      },
    }))

  return {
    async enqueue(job, payload, options) {
      await queue().add(job.name, job.schema.parse(payload), bullJobOptions(options))
    },
    async schedule(scheduleId, job, payload, options) {
      await queue().upsertJobScheduler(scheduleId, { every: options.everyMs }, { name: job.name, data: job.schema.parse(payload) })
    },
    async ping() {
      // BullMQ 6 hides the raw client behind a pluggable backend; reading the
      // queue's meta hash is a typed, backend-agnostic round trip.
      await queue().getVersion()
    },
    async close() {
      await instance?.close()
    },
  }
}

type ProcessedJob = Pick<Job, 'id' | 'name' | 'data' | 'attemptsMade' | 'opts' | 'moveToDelayed' | 'updateData'>

/**
 * Job data key holding the `RetryLaterError` count of the current attempt. It lives in the
 * job's data so it survives the move to delayed; it is stripped before the payload is parsed.
 */
export const RETRY_LATER_KEY = '__retryLater'

function splitJobData(data: unknown, attempt: number): { payload: unknown; retriedLater: number } {
  if (typeof data !== 'object' || data === null || !(RETRY_LATER_KEY in data)) return { payload: data, retriedLater: 0 }
  const { [RETRY_LATER_KEY]: marker, ...payload } = data as Record<string, unknown>
  const { attempt: markedAttempt, count } = (marker ?? {}) as { attempt?: unknown; count?: unknown }
  // A count recorded during an earlier attempt does not carry over: an attempt was used since.
  const retriedLater = markedAttempt === attempt && typeof count === 'number' && Number.isInteger(count) && count > 0 ? count : 0
  return { payload, retriedLater }
}

/** Runs one BullMQ job and maps the engine-neutral job errors to BullMQ's. */
export function createJobProcessor(ctx: Context, jobs: JobDefinition[]): (job: ProcessedJob, token?: string) => Promise<void> {
  const byName = new Map(jobs.map((job) => [job.name, job]))
  return async (job, token) => {
    const definition = byName.get(job.name)
    if (!definition) throw new UnrecoverableError(`Unknown job "${job.name}"`)
    const attempt = job.attemptsMade + 1
    const { payload: data, retriedLater } = splitJobData(job.data, attempt)
    const payload = definition.schema.safeParse(data)
    if (!payload.success) throw new UnrecoverableError(`Invalid payload for "${job.name}": ${payload.error.message}`)
    try {
      await definition.handler(ctx, payload.data, { attempt, maxAttempts: job.opts.attempts ?? 1, retriedLater })
    } catch (error) {
      if (error instanceof RetryLaterError) {
        ctx.log.info('job retries later', { name: job.name, id: job.id, delayMs: error.delayMs, reason: error.message })
        await job.updateData({ ...(data as Record<string, unknown>), [RETRY_LATER_KEY]: { attempt, count: retriedLater + 1 } })
        // Moving to delayed this way does not count as an attempt.
        await job.moveToDelayed(Date.now() + error.delayMs, token)
        throw new DelayedError()
      }
      if (error instanceof PermanentJobError) throw new UnrecoverableError(error.message)
      throw error
    }
  }
}

export function startWorker(ctx: Context, jobs: JobDefinition[], options: { concurrency: number }): QueueWorker {
  const worker = new Worker(QUEUE_NAME, createJobProcessor(ctx, jobs), {
    connection: redisConnection(ctx.env.REDIS_URL),
    prefix: ctx.env.HANZA_QUEUE_PREFIX,
    concurrency: options.concurrency,
  })
  worker.on('ready', () => ctx.log.info('worker ready', { jobs: jobs.map((job) => job.name), concurrency: options.concurrency }))
  worker.on('completed', (job) => ctx.log.info('job completed', { name: job.name, id: job.id }))
  worker.on('failed', (job, error) =>
    ctx.log.error('job failed', { name: job?.name, id: job?.id, attemptsMade: job?.attemptsMade, error: describeFailure(error) }),
  )
  worker.on('error', (error) => ctx.log.error('worker error', { error: error.message }))
  return { close: () => worker.close() }
}
