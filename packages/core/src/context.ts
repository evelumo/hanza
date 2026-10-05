import type { AnyConnectorDefinition } from '@hanza/connector-sdk'
import { createDb, type Db } from '@hanza/db'
import { createConnectorRegistry, type ConnectorRegistry } from './connectors/registry'
import { loadEnv, type Env } from './env'
import { createLogger, type Logger } from './logger'
import { createJobQueue, type JobQueue } from './queue'
import { createSecretBox, type SecretBox } from './secrets'

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
}

export interface CreateContextOptions {
  env?: Env
  /** Usually `connectors` from `@hanza/connector-registry`; empty when omitted. */
  connectors?: AnyConnectorDefinition[]
}

export function createContext(scope: string, options: CreateContextOptions = {}): Context {
  const env = options.env ?? loadEnv()
  return {
    env,
    db: createDb(env.DATABASE_URL),
    queue: createJobQueue(env.REDIS_URL, { prefix: env.HANZA_QUEUE_PREFIX }),
    log: createLogger(scope),
    secrets: createSecretBox(env.HANZA_ENCRYPTION_KEY),
    connectors: createConnectorRegistry(options.connectors ?? []),
  }
}

export async function closeContext(ctx: Context): Promise<void> {
  await ctx.queue.close()
  await ctx.db.$disconnect()
}
