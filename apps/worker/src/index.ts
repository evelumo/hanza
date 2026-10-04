import { connectors } from '@hanza/connector-registry'
import { TICK_EVERY_MS, closeContext, createContext, jobs, startWorker, syncTickRef } from '@hanza/core'

const ctx = createContext('worker', { connectors })

const worker = startWorker(ctx, jobs, { concurrency: Number(process.env.WORKER_CONCURRENCY ?? 10) })

// Idempotent: every worker start updates the same scheduler instead of adding one.
await ctx.queue.schedule('sync.tick', syncTickRef, {}, { everyMs: TICK_EVERY_MS })
ctx.log.info('sync tick scheduled', { everyMs: TICK_EVERY_MS, connectors: connectors.map((connector) => connector.id) })

async function shutdown(signal: string) {
  ctx.log.info('shutting down', { signal })
  await worker.close()
  await closeContext(ctx)
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
