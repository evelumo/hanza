/** What the runner (`run.ts`) hands to Playwright; flows read it through the fixtures. */
export const RUN_ENV = {
  baseUrl: 'HANZA_E2E_BASE_URL',
  probeUrl: 'HANZA_E2E_PROBE_URL',
  databaseUrl: 'HANZA_E2E_DATABASE_URL',
} as const

export function readRunEnv(name: keyof typeof RUN_ENV): string {
  const value = process.env[RUN_ENV[name]]
  if (!value) throw new Error(`${RUN_ENV[name]} is not set: start the suite with \`pnpm test:e2e\`, which sets up the app it tests`)
  return value
}
