import { randomBytes, randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hanza/db'
import type { Context } from '../context'
import type { Logger } from '../logger'
import { createSecretBox } from '../secrets'
import { createInMemoryJobQueue, type InMemoryJobQueue } from './queue'

export type TestContext = Context & { queue: InMemoryJobQueue }

const silentLogger: Logger = { info() {}, error() {} }

/** A real database, a random encryption key, a silent logger and an in-memory queue. */
export function createTestContext(options: { databaseUrl: string }): TestContext {
  const key = randomBytes(32).toString('base64')
  return {
    env: { DATABASE_URL: options.databaseUrl, REDIS_URL: 'redis://localhost:6379', HANZA_ENCRYPTION_KEY: key },
    db: createDb(options.databaseUrl),
    queue: createInMemoryJobQueue(),
    log: silentLogger,
    secrets: createSecretBox(key),
  }
}

/** Tests isolate by organization, never by truncating tables. */
export async function createTestOrganization(db: Db): Promise<string> {
  const id = randomUUID()
  await db.organization.create({ data: { id, name: `Test ${id.slice(0, 8)}`, slug: `test-${id}`, createdAt: new Date() } })
  return id
}
