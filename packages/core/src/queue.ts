import { Queue, type ConnectionOptions } from 'bullmq'
import type { z } from 'zod'
import type { JobDefinition } from './jobs'

export const QUEUE_NAME = 'hanza'

/**
 * The only queue API the rest of the code sees. BullMQ stays behind it so the
 * engine can be swapped (e.g. for Temporal) without touching callers.
 */
export interface JobQueue {
  enqueue<TSchema extends z.ZodType>(job: JobDefinition<TSchema>, payload: z.input<TSchema>): Promise<void>
  ping(): Promise<void>
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

export function createJobQueue(redisUrl: string): JobQueue {
  // Created on first use, so importing the context never opens a connection.
  let instance: Queue | undefined
  const queue = () =>
    (instance ??= new Queue(QUEUE_NAME, {
      connection: redisConnection(redisUrl),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 5_000 },
      },
    }))

  return {
    async enqueue(job, payload) {
      await queue().add(job.name, job.schema.parse(payload))
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
