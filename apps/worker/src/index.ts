import { connectors } from '@hanza/connector-registry'
import {
  PRIVACY_TICK_EVERY_MS,
  TICK_EVERY_MS,
  closeContext,
  createContext,
  jobs,
  loadWorkerEnv,
  privacyTickRef,
  startWorker,
  syncTickRef,
} from '@hanza/core'

const { WORKER_CONCURRENCY } = loadWorkerEnv()
const ctx = createContext('worker', { connectors })

const worker = startWorker(ctx, jobs, { concurrency: WORKER_CONCURRENCY })

// Idempotent: every worker start updates the same scheduler instead of adding one.
await ctx.queue.schedule('sync.tick', syncTickRef, {}, { everyMs: TICK_EVERY_MS })
ctx.log.info('sync tick scheduled', { everyMs: TICK_EVERY_MS, connectors: connectors.map((connector) => connector.id) })
// Seals legacy Buyer data and applies retention periods (ADR 0011).
await ctx.queue.schedule('privacy.tick', privacyTickRef, {}, { everyMs: PRIVACY_TICK_EVERY_MS })

async function shutdown(signal: string) {
  ctx.log.info('shutting down', { signal })
  await worker.close()
  await closeContext(ctx)
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
