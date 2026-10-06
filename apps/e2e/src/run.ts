// `pnpm test:e2e`: sets up a throwaway Hanza (database, queue key prefix, worker, web app), runs the
// Playwright flows against it and tears it all down. What is torn down when:
// - normal end, failing flows, SIGINT/SIGTERM/SIGHUP to the runner or its group: everything, here;
// - SIGKILL of the runner: its processes die with it (parent-guard.mjs); its database and queue keys
//   stay recorded in Redis and the next run on this machine removes them (run-registry.ts).
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { hostname } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { createTestDatabase } from '@hanza/db/testing'
import { chromium } from '@playwright/test'
import { freePort, startService, waitUntil, type Service } from './processes'
import { RUN_ENV } from './run-env'
import { processState } from './run-processes'
import { RunRegistry, namesFor, newRunId, serverOf, type RunRecord } from './run-registry'
import { StoppedError, Teardown } from './teardown'

const root = join(import.meta.dirname, '..', '..', '..')
const e2eDir = join(root, 'apps', 'e2e')
const webDir = join(root, 'apps', 'web')
const workerDir = join(root, 'apps', 'worker')
// One directory per run (logs, traces, report), so parallel runs never write to the same files.
const resultsDir = join(e2eDir, 'results')
const READY_TIMEOUT_MS = 60_000
const EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const

const log = (message: string) => console.log(`[e2e] ${message}`)
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`
const teardown = new Teardown(log)

for (const signal of Object.keys(EXIT_CODES) as Array<keyof typeof EXIT_CODES>) {
  // `on`, not `once`: Ctrl-C can arrive twice (terminal and pnpm), and a second signal without a
  // handler would kill this process halfway through the teardown.
  process.on(signal, () => {
    if (!teardown.stopping) log(`${signal}: tearing down`)
    void teardown.run().finally(() => process.exit(EXIT_CODES[signal]))
  })
}

async function browserInstalled(): Promise<boolean> {
  try {
    await (await chromium.launch()).close()
    return true
  } catch (error) {
    if (error instanceof Error && /Executable doesn't exist|install/i.test(error.message)) return false
    throw error
  }
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

  const registry = await RunRegistry.connect(redisUrl, adminUrl)
  teardown.add('disconnect from Redis', async () => registry.close())
  for (const runId of await teardown.track(registry.recoverDeadRuns(log))) log(`removed the leftovers of dead run ${runId}`)

  const runId = newRunId()
  const { queuePrefix, database } = namesFor(runId)
  const [webPort, probePort] = [await freePort(), await freePort()]
  const self = processState(process.pid)
  if (self.kind !== 'running') throw new Error('Cannot read this process’s start time from `ps`')
  const startedAt = self.startedAt
  const record: RunRecord = {
    runId,
    host: hostname(),
    pid: process.pid,
    startedAt,
    queuePrefix,
    database: { name: database, server: serverOf(adminUrl) },
    ports: [webPort, probePort],
    services: [],
  }
  // Recorded before anything is created, removed only once everything is gone.
  await teardown.track(registry.save(record))
  teardown.add(`remove database ${database}, queue keys ${queuePrefix}:* and the run record`, () => registry.destroy(record, { killProcesses: false }))
  const services: Service[] = []
  const start = async (...args: Parameters<typeof startService>) => {
    const service = startService(...args)
    teardown.add(`stop ${service.name}`, () => service.stop())
    services.push(service)
    const state = service.pid ? processState(service.pid) : undefined
    record.services.push({ name: service.name, pid: service.pid, startedAt: state?.kind === 'running' ? state.startedAt : undefined })
    await teardown.track(registry.save(record))
    return service
  }
  const outputDir = join(resultsDir, runId)
  const logDir = join(outputDir, 'logs')
  mkdirSync(logDir, { recursive: true })
  log(`run ${runId}: database ${database}, queue prefix ${queuePrefix}, web on port ${webPort}, results in ${outputDir}`)

  log('building the web app (cached by turbo when nothing changed)')
  const buildStarted = Date.now()
  const turbo = join(root, 'node_modules', 'turbo', 'bin', 'turbo')
  const build = await start('build', [turbo, 'run', 'build', '--filter=@hanza/web', '--output-logs=errors-only'], {
    cwd: root,
    env: process.env,
    runId,
    output: 'inherit',
  })
  if ((await teardown.interruptible(build.exited)) !== 0) throw new Error('the web app did not build')
  const buildMs = Date.now() - buildStarted

  const setupStarted = Date.now()
  const { url: databaseUrl } = await teardown.track(createTestDatabase(adminUrl, { name: database }))
  const baseUrl = `http://127.0.0.1:${webPort}`
  const probeUrl = `http://127.0.0.1:${probePort}`
  // Every variable the apps read is set here, so the root .env (which next.config.ts loads) never wins.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    HANZA_QUEUE_PREFIX: queuePrefix,
    BETTER_AUTH_URL: baseUrl,
    BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
    HANZA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    WORKER_CONCURRENCY: '5',
    PORT: String(webPort),
  }
  try {
    const probe = join(e2eDir, 'src', 'fake-channel-probe.ts')
    const worker = await start('worker', ['--import', 'tsx', '--import', probe, 'src/index.ts'], {
      cwd: workerDir,
      env: { ...env, HANZA_E2E_PROBE_PORT: String(probePort) },
      runId,
      output: join(logDir, 'worker.log'),
    })
    const nextBin = createRequire(join(webDir, 'package.json')).resolve('next/dist/bin/next')
    const web = await start('web', [nextBin, 'start', '--port', String(webPort), '--hostname', '127.0.0.1'], {
      cwd: webDir,
      env: { ...env, NODE_ENV: 'production' },
      runId,
      output: join(logDir, 'web.log'),
    })
    const ready = (service: Service, what: string, check: () => Promise<boolean>) => teardown.interruptible(waitUntil(service, what, check, READY_TIMEOUT_MS))
    await ready(worker, 'the worker is ready', async () => worker.tail(200).includes('"message":"worker ready"'))
    await ready(worker, 'the fake Channel probe answers', async () => (await fetch(`${probeUrl}/fake-channel`)).ok)
    await ready(web, 'GET /api/health is ok', async () => (await fetch(`${baseUrl}/api/health`)).ok)
  } catch (error) {
    if (!(error instanceof StoppedError)) for (const service of services) console.error(`\n[e2e] last lines of ${service.name}:\n${service.tail()}`)
    throw error
  }
  const setupMs = Date.now() - setupStarted
  log(`app at ${baseUrl}`)

  const testsStarted = Date.now()
  const cli = createRequire(join(e2eDir, 'package.json')).resolve('@playwright/test/cli')
  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  const playwright = await start('playwright', [cli, 'test', ...args], {
    cwd: e2eDir,
    env: { ...process.env, [RUN_ENV.baseUrl]: baseUrl, [RUN_ENV.probeUrl]: probeUrl, [RUN_ENV.databaseUrl]: databaseUrl, [RUN_ENV.outputDir]: outputDir },
    runId,
    output: 'inherit',
  })
  const exitCode = await teardown.interruptible(playwright.exited)
  const testsMs = Date.now() - testsStarted

  const teardownStarted = Date.now()
  const clean = await teardown.run()
  log(
    `timings: build ${seconds(buildMs)}, setup ${seconds(setupMs)}, flows ${seconds(testsMs)}, ` +
      `teardown ${seconds(Date.now() - teardownStarted)}, total ${seconds(Date.now() - started)}`,
  )
  if (exitCode === 0 && clean) rmSync(outputDir, { recursive: true, force: true })
  else log(`kept for inspection: ${outputDir} (server logs in logs/, traces in test-results/, report/index.html)`)
  if (!clean) return 1
  return typeof exitCode === 'number' ? exitCode : 1
}

main()
  .then(async (code) => {
    const clean = await teardown.run()
    process.exit(clean ? code : 1)
  })
  .catch(async (error: unknown) => {
    if (!(error instanceof StoppedError)) console.error('[e2e]', error instanceof Error ? error.message : error)
    await teardown.run()
    // A signal handler is exiting with its own code; this only ends runs that failed on their own.
    if (!(error instanceof StoppedError)) process.exit(1)
  })
