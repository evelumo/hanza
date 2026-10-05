import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

const rootEnv = join(import.meta.dirname, '..', '..', '.env')
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv)

export default defineConfig({
  test: {
    globalSetup: ['./vitest.global-setup.ts'],
    // The files share one throwaway database, and `sync.tick` is global: a tick in one file enqueues the pulls and
    // pushes of the other file's Connections, which then run against the wrong fake Channel.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
