import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { NextConfig } from 'next'

// One .env at the repo root is shared by web, worker and Prisma.
const rootEnv = join(process.cwd(), '..', '..', '.env')
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv)

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript sources.
  transpilePackages: ['@hanza/core', '@hanza/db'],
}

export default nextConfig
