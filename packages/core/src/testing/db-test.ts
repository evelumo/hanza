import { afterAll, beforeAll, inject } from 'vitest'
import { createTestContext, type TestContext } from './context'

// For core's own `*.db.test.ts` files; not exported from `@hanza/core/testing`.

export const databaseUrl = inject('hanzaTestDatabaseUrl')

/** Call inside `describe.skipIf(!databaseUrl)`; returns a getter for a context on the run's test database. */
export function useTestContext(): () => TestContext {
  let ctx: TestContext | undefined
  beforeAll(() => {
    if (!databaseUrl) throw new Error('HANZA_TEST_DATABASE_URL is not set')
    ctx = createTestContext({ databaseUrl })
  })
  afterAll(async () => {
    await ctx?.db.$disconnect()
  })
  return () => {
    if (!ctx) throw new Error('Test context used outside a test')
    return ctx
  }
}
