import { Worker } from 'bullmq'
import { QUEUE_NAME, closeContext, createContext, findJob, jobs, redisConnection } from '@hanza/core'

const ctx = createContext('worker')

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const definition = findJob(job.name)
    if (!definition) throw new Error(`Unknown job "${job.name}"`)
    await definition.handler(ctx, definition.schema.parse(job.data), {
      attempt: job.attemptsMade + 1,
      maxAttempts: job.opts.attempts ?? 1,
    })
  },
  {
    connection: redisConnection(ctx.env.REDIS_URL),
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 10),
  },
)

worker.on('ready', () => ctx.log.info('worker ready', { jobs: jobs.map((job) => job.name) }))
worker.on('completed', (job) => ctx.log.info('job completed', { name: job.name, id: job.id }))
worker.on('failed', (job, error) =>
  ctx.log.error('job failed', { name: job?.name, id: job?.id, attempt: job?.attemptsMade, error: error.message }),
)
worker.on('error', (error) => ctx.log.error('worker error', { error: error.message }))

async function shutdown(signal: string) {
  ctx.log.info('shutting down', { signal })
  await worker.close()
  await closeContext(ctx)
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
