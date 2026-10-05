import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'

const STOP_GRACE_MS = 10_000

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
  logFile: string
  /** Set once the process has exited. */
  readonly exitCode: number | string | null | undefined
  /** SIGTERM to the whole process group, SIGKILL after a grace period. Safe to call twice. */
  stop(): Promise<void>
  tail(lines?: number): string
}

/** Starts a process in its own process group (so `stop` also reaches its children), output to `logFile`. */
export function startService(
  name: string,
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; logFile: string },
): Service {
  const fd = openSync(options.logFile, 'w')
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore', fd, fd] })
  closeSync(fd)
  let exitCode: number | string | null | undefined
  const exited = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      exitCode = code ?? signal
      resolve()
    })
    child.once('error', (error) => {
      exitCode = error.message
      resolve()
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
    logFile: options.logFile,
    get exitCode() {
      return exitCode
    },
    async stop() {
      signalGroup('SIGTERM')
      const stopped = await Promise.race([exited.then(() => true), sleep(STOP_GRACE_MS).then(() => false)])
      // Children of the group leader may outlive it; they get no second chance.
      signalGroup('SIGKILL')
      if (!stopped) await exited
    },
    tail(lines = 40) {
      try {
        return readFileSync(options.logFile, 'utf8').trimEnd().split('\n').slice(-lines).join('\n')
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
