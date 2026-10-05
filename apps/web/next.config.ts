import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

// One .env at the repo root is shared by web, worker and Prisma.
const rootEnv = join(process.cwd(), '..', '..', '.env')
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv)

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript sources.
  transpilePackages: ['@hanza/core', '@hanza/db', '@hanza/connector-sdk', '@hanza/connector-registry', '@hanza/connector-fake'],
}

// Finds src/i18n/request.ts, which resolves the locale of each request.
const withNextIntl = createNextIntlPlugin()

export default withNextIntl(nextConfig)
