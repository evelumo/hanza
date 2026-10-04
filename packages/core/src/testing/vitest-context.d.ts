export {}

declare module 'vitest' {
  export interface ProvidedContext {
    /** Fresh database for this test run, or null when HANZA_TEST_DATABASE_URL is unset. */
    hanzaTestDatabaseUrl: string | null
  }
}
