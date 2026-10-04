import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'prisma/config'

const rootEnv = join(import.meta.dirname, '..', '..', '.env')
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv)

export default defineConfig({
  // A directory: every module keeps its models in its own .prisma file.
  schema: 'prisma/schema',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // `prisma generate` runs without a database (e.g. in CI).
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/hanza',
  },
})
