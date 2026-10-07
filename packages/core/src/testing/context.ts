import { randomBytes, randomUUID } from 'node:crypto'
import type { AnyConnectorDefinition } from '@hanza/connector-sdk'
import { createDb, type Db } from '@hanza/db'
import { createConnectorRegistry } from '../connectors/registry'
import type { Context } from '../context'
import type { Logger } from '../logger'
import { createInMemoryRateLimiter, type RateLimiter } from '../rate-limit'
import { createSecretBox } from '../secrets'
import { createWorkflowEngine } from '../workflows/engine'
import { createInMemoryJobQueue, type InMemoryJobQueue } from './queue'

export type TestContext = Context & { queue: InMemoryJobQueue }

const silentLogger: Logger = { info() {}, warn() {}, error() {} }

/**
 * A real database, a random encryption key, a silent logger, an in-memory queue, the given connectors and the
 * workflow engine on them, and an in-memory rate limiter unless `rateLimiter` is given (e.g. a Redis one shared by
 * two contexts standing for two workers). Connector installation settings come only from `connectorSettings`
 * (never the machine's environment).
 */
export function createTestContext(options: {
  databaseUrl: string
  connectors?: AnyConnectorDefinition[]
  connectorSettings?: Readonly<Record<string, string>>
  rateLimiter?: RateLimiter
}): TestContext {
  const key = randomBytes(32).toString('base64')
  const db = createDb(options.databaseUrl)
  const queue = createInMemoryJobQueue()
  return {
    env: { DATABASE_URL: options.databaseUrl, REDIS_URL: 'redis://localhost:6379', HANZA_ENCRYPTION_KEY: key },
    db,
    queue,
    log: silentLogger,
    secrets: createSecretBox(key),
    connectors: createConnectorRegistry(options.connectors ?? [], { settings: options.connectorSettings ?? {} }),
    workflows: createWorkflowEngine({ db, queue, log: silentLogger }),
    rateLimiter: options.rateLimiter ?? createInMemoryRateLimiter(),
  }
}

/** Tests isolate by organization, never by truncating tables. */
export async function createTestOrganization(db: Db): Promise<string> {
  const id = randomUUID()
  await db.organization.create({ data: { id, name: `Test ${id.slice(0, 8)}`, slug: `test-${id}`, createdAt: new Date() } })
  return id
}
