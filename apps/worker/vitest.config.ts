import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

const rootEnv = join(import.meta.dirname, '..', '..', '.env')
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv)

export default defineConfig({
  test: {
    globalSetup: ['./vitest.global-setup.ts'],
    // The test files share one database and sync.tick reads every Connection in it (ADR 0008): run them one at a
    // time, so a tick in one file never runs jobs for another file's Connections while that file is asserting (#55).
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
