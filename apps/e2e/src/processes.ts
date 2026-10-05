import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

const STOP_GRACE_MS = 10_000
const GUARD = pathToFileURL(join(import.meta.dirname, 'parent-guard.mjs')).href

/** The `--import` URL of the parent guard; the run id in it marks the process as this run's. */
export function guardImport(runId: string): string {
  return `${GUARD}?run=${runId}`
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('No port'))))
    })
  })
}

export interface Service {
  name: string
  pid: number | undefined
  /** Resolves with the exit code or signal once the process has exited. */
  exited: Promise<number | string | null>
  /** Set once the process has exited. */
  readonly exitCode: number | string | null | undefined
  /** SIGTERM to the whole process group, SIGKILL after a grace period. Safe to call twice. */
  stop(): Promise<void>
  /** Last lines of the log file ('' for inherited output). */
  tail(lines?: number): string
}

/**
 * Runs `node <args>` in its own process group with the parent guard preloaded: `stop` reaches the
 * process and all its children, and if this process dies (even by SIGKILL) the guard kills the group.
 * Output goes to `output` (a log file) or to this process's stdout/stderr.
 */
export function startService(
  name: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; runId: string; output: string | 'inherit' },
): Service {
  const fd = options.output === 'inherit' ? undefined : openSync(options.output, 'w')
  // The guard arms itself once per process tree; this process is the root of a new one.
  const { HANZA_E2E_GUARD_ARMED: _armed, ...env } = options.env
  const child = spawn(process.execPath, ['--import', guardImport(options.runId), ...args], {
    cwd: options.cwd,
    env,
    detached: true,
    // stdin stays an open pipe nobody writes to: the guard's lifeline to this process.
    stdio: ['pipe', fd ?? 'inherit', fd ?? 'inherit'],
  })
  if (fd !== undefined) closeSync(fd)
  let exitCode: number | string | null | undefined
  const exited = new Promise<number | string | null>((resolve) => {
    child.once('exit', (code, signal) => {
      exitCode = code ?? signal
      resolve(exitCode)
    })
    child.once('error', (error) => {
      exitCode = error.message
      resolve(exitCode)
    })
  })
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, signal)
    } catch {
      // The group is already gone.
    }
  }

  return {
    name,
    pid: child.pid,
    exited,
    get exitCode() {
      return exitCode
    },
    async stop() {
      signalGroup('SIGTERM')
      const stopped = await Promise.race([exited.then(() => true), sleep(STOP_GRACE_MS).then(() => false)])
      // Children of the group leader may outlive it; they get no second chance.
      signalGroup('SIGKILL')
      if (!stopped) await exited
      child.stdin?.destroy()
    },
    tail(lines = 40) {
      if (options.output === 'inherit') return ''
      try {
        return readFileSync(options.output, 'utf8').trimEnd().split('\n').slice(-lines).join('\n')
      } catch {
        return ''
      }
    },
  }
}

/** Polls `ready` until it returns true; fails early when the service has exited. */
export async function waitUntil(service: Service, what: string, ready: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (service.exitCode !== undefined) throw new Error(`${service.name} exited (${service.exitCode}) before ${what}`)
    if (await ready().catch(() => false)) return
    await sleep(250)
  }
  throw new Error(`${service.name}: ${what} did not happen within ${timeoutMs / 1000} s`)
}
