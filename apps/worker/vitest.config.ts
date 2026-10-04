import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

const rootEnv = join(import.meta.dirname, '..', '..', '.env')
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv)

export default defineConfig({
  test: {
    globalSetup: ['./vitest.global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
