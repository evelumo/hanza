// `pnpm test:e2e`: sets up a throwaway Hanza (database, Redis index, worker, web app), runs the
// Playwright flows against it and tears it all down, also when a flow fails or the run is interrupted.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createTestDatabase } from '@hanza/db/testing'
import { chromium } from '@playwright/test'
import { freePort, startService, waitUntil, type Service } from './processes'
import { claimRedisSlot } from './redis-slot'
import { RUN_ENV } from './run-env'

const root = join(import.meta.dirname, '..', '..', '..')
const e2eDir = join(root, 'apps', 'e2e')
const webDir = join(root, 'apps', 'web')
const workerDir = join(root, 'apps', 'worker')
const logDir = join(e2eDir, 'logs')
const READY_TIMEOUT_MS = 60_000

const log = (message: string) => console.log(`[e2e] ${message}`)
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

async function browserInstalled(): Promise<boolean> {
  try {
    await (await chromium.launch()).close()
    return true
  } catch (error) {
    if (error instanceof Error && /Executable doesn't exist|install/i.test(error.message)) return false
    throw error
  }
}

function runToEnd(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })
}

// Teardown steps, run last-registered first; `cleanup` is shared by the normal exit and the signal handlers.
const teardown: Array<{ name: string; run: () => Promise<void> }> = []
let cleaning: Promise<void> | undefined
function cleanup(): Promise<void> {
  cleaning ??= (async () => {
    for (const step of teardown.reverse()) {
      const stepStarted = Date.now()
      await step.run().catch((error: unknown) => console.error(`[e2e] teardown "${step.name}" failed:`, error))
      log(`teardown: ${step.name} (${seconds(Date.now() - stepStarted)})`)
    }
  })()
  return cleaning
}

// `on`, not `once`: Ctrl-C reaches this process twice (from the terminal and forwarded by pnpm), and a
// second signal without a handler would kill it before the database is dropped.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (!cleaning) log(`${signal}: tearing down`)
    void cleanup().finally(() => process.exit(130))
  })
}

async function main(): Promise<number> {
  const started = Date.now()
  const rootEnv = join(root, '.env')
  // Never overrides variables that are already set.
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv)

  const adminUrl = process.env.HANZA_TEST_DATABASE_URL
  if (!adminUrl) {
    log('skipped: HANZA_TEST_DATABASE_URL is not set (see .env.example)')
    return 0
  }
  if (!(await browserInstalled())) {
    log('skipped: the Playwright browser is not installed; run `pnpm --filter @hanza/e2e exec playwright install chromium`')
    return 0
  }
  const redisUrl = process.env.REDIS_URL
  if (!redisUrl) throw new Error('REDIS_URL is not set: the run needs Redis (`pnpm infra:up`)')

  log('building the web app (cached by turbo when nothing changed)')
  const buildStarted = Date.now()
  if ((await runToEnd('pnpm', ['exec', 'turbo', 'run', 'build', '--filter=@hanza/web', '--output-logs=errors-only'], { cwd: root })) !== 0) {
    throw new Error('the web app did not build')
  }
  const buildMs = Date.now() - buildStarted

  const setupStarted = Date.now()
  const database = await createTestDatabase(adminUrl)
  teardown.push({ name: 'drop database', run: database.drop })
  const redis = await claimRedisSlot(redisUrl)
  teardown.push({ name: 'release Redis index', run: redis.release })

  const [webPort, probePort] = [await freePort(), await freePort()]
  const baseUrl = `http://127.0.0.1:${webPort}`
  const probeUrl = `http://127.0.0.1:${probePort}`
  // Every variable the apps read is set here, so the root .env (which next.config.ts loads) never wins.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: database.url,
    REDIS_URL: redis.url,
    BETTER_AUTH_URL: baseUrl,
    BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
    HANZA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    WORKER_CONCURRENCY: '5',
    PORT: String(webPort),
  }
  mkdirSync(logDir, { recursive: true })
  const services: Service[] = []
  const stopServices = { name: 'stop processes', run: async () => void (await Promise.all(services.map((service) => service.stop()))) }
  teardown.push(stopServices)

  try {
    const probe = pathToFileURL(join(e2eDir, 'src', 'fake-channel-probe.ts')).href
    const worker = startService('worker', process.execPath, ['--import', 'tsx', '--import', probe, 'src/index.ts'], {
      cwd: workerDir,
      env: { ...env, HANZA_E2E_PROBE_PORT: String(probePort) },
      logFile: join(logDir, 'worker.log'),
    })
    services.push(worker)
    const nextBin = createRequire(join(webDir, 'package.json')).resolve('next/dist/bin/next')
    const web = startService('web', process.execPath, [nextBin, 'start', '--port', String(webPort), '--hostname', '127.0.0.1'], {
      cwd: webDir,
      env: { ...env, NODE_ENV: 'production' },
      logFile: join(logDir, 'web.log'),
    })
    services.push(web)

    await waitUntil(worker, 'the worker is ready', async () => worker.tail(200).includes('"message":"worker ready"'), READY_TIMEOUT_MS)
    await waitUntil(worker, 'the fake Channel probe answers', async () => (await fetch(`${probeUrl}/fake-channel`)).ok, READY_TIMEOUT_MS)
    await waitUntil(web, 'GET /api/health is ok', async () => (await fetch(`${baseUrl}/api/health`)).ok, READY_TIMEOUT_MS)
  } catch (error) {
    for (const service of services) console.error(`\n[e2e] last lines of ${service.logFile}:\n${service.tail()}`)
    throw error
  }
  const setupMs = Date.now() - setupStarted
  log(`app at ${baseUrl}, Redis index ${redis.index}; server logs in ${logDir}`)

  const testsStarted = Date.now()
  const cli = createRequire(join(e2eDir, 'package.json')).resolve('@playwright/test/cli')
  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  const exitCode = await runToEnd(process.execPath, [cli, 'test', ...args], {
    cwd: e2eDir,
    env: { ...process.env, [RUN_ENV.baseUrl]: baseUrl, [RUN_ENV.probeUrl]: probeUrl, [RUN_ENV.databaseUrl]: database.url },
  })
  const testsMs = Date.now() - testsStarted
  if (exitCode !== 0) log(`flows failed; server logs in ${logDir}`)

  const teardownStarted = Date.now()
  await cleanup()
  log(
    `timings: build ${seconds(buildMs)}, setup ${seconds(setupMs)}, flows ${seconds(testsMs)}, ` +
      `teardown ${seconds(Date.now() - teardownStarted)}, total ${seconds(Date.now() - started)}`,
  )
  return exitCode
}

main()
  .then(async (code) => {
    await cleanup()
    process.exit(code)
  })
  .catch(async (error: unknown) => {
    console.error('[e2e]', error instanceof Error ? error.message : error)
    await cleanup()
    process.exit(1)
  })
