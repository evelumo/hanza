import type { AnyConnectorDefinition } from '@hanza/connector-sdk'
import { createDb, type Db } from '@hanza/db'
import { createConnectorRegistry, type ConnectorRegistry } from './connectors/registry'
import { loadEnv, type Env } from './env'
import { createLogger, type Logger } from './logger'
import { createJobQueue, type JobQueue } from './queue'
import { createRedisRateLimiter, type RateLimiter } from './rate-limit'
import { createSecretBox, type SecretBox } from './secrets'
import { createWorkflowEngine, type WorkflowEngine } from './workflows/engine'

/**
 * Everything a command, job or route needs. Built once per process by
 * `createContext()` — no DI container, dependencies are passed explicitly.
 */
export interface Context {
  env: Env
  db: Db
  queue: JobQueue
  log: Logger
  secrets: SecretBox
  connectors: ConnectorRegistry
  workflows: WorkflowEngine
  /** Request budgets the connectors declare, shared by every worker (ADR 0019). */
  rateLimiter: RateLimiter
}

export interface CreateContextOptions {
  env?: Env
  /** Usually `connectors` from `@hanza/connector-registry`; empty when omitted. */
  connectors?: AnyConnectorDefinition[]
  /** Where the connectors' installation settings (`HANZA_CONNECTOR_*`) are read from; `process.env` when omitted. */
  connectorSettings?: Readonly<Record<string, string | undefined>>
}

export function createContext(scope: string, options: CreateContextOptions = {}): Context {
  const env = options.env ?? loadEnv()
  const db = createDb(env.DATABASE_URL)
  const queue = createJobQueue(env.REDIS_URL, { prefix: env.HANZA_QUEUE_PREFIX })
  const log = createLogger(scope)
  return {
    env,
    db,
    queue,
    log,
    secrets: createSecretBox(env.HANZA_ENCRYPTION_KEY),
    connectors: createConnectorRegistry(options.connectors ?? [], { settings: options.connectorSettings ?? process.env }),
    workflows: createWorkflowEngine({ db, queue, log }),
    // With HANZA_QUEUE_PREFIX set (e2e runs) the queue's prefix, so a run that deletes `<prefix>:*` also deletes its
    // budgets; otherwise "hanza" (BullMQ's own default is "bull"). Refuses requests while Redis is unreachable.
    rateLimiter: createRedisRateLimiter(env.REDIS_URL, { prefix: env.HANZA_QUEUE_PREFIX ?? 'hanza', log }),
  }
}

export async function closeContext(ctx: Context): Promise<void> {
  await ctx.queue.close()
  await ctx.rateLimiter.close()
  await ctx.db.$disconnect()
}
