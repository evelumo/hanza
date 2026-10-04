import { afterAll, beforeAll, inject } from 'vitest'
import { createTestContext, type TestContext } from './context'
import { withApplicationName } from './lock-waits'

// For core's own `*.db.test.ts` files; not exported from `@hanza/core/testing`.

export const databaseUrl = inject('hanzaTestDatabaseUrl')

/**
 * Call inside `describe.skipIf(!databaseUrl)`; returns a getter for a context on the run's test database.
 * `applicationName` tags its sessions (see `lock-waits.ts`).
 */
export function useTestContext(options: { applicationName?: string } = {}): () => TestContext {
  let ctx: TestContext | undefined
  beforeAll(() => {
    if (!databaseUrl) throw new Error('HANZA_TEST_DATABASE_URL is not set')
    const url = options.applicationName ? withApplicationName(databaseUrl, options.applicationName) : databaseUrl
    ctx = createTestContext({ databaseUrl: url })
  })
  afterAll(async () => {
    await ctx?.db.$disconnect()
  })
  return () => {
    if (!ctx) throw new Error('Test context used outside a test')
    return ctx
  }
}
