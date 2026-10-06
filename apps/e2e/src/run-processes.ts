import { execFileSync, spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

export interface ProcessInfo {
  pid: number
  pgid: number
  command: string
}

/** Parses `ps -A -o pid=,pgid=,command=`. */
export function parseProcessTable(output: string): ProcessInfo[] {
  return output.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return match ? [{ pid: Number(match[1]), pgid: Number(match[2]), command: match[3]! }] : []
  })
}

/**
 * The processes of run `runId`: those whose command line carries the parent guard of that run
 * (`parent-guard.mjs?run=<id>`), which no unrelated process can have, so a reused PID is never hit.
 */
export function processesOfRun(table: ProcessInfo[], runId: string): ProcessInfo[] {
  const marker = `parent-guard.mjs?run=${runId}`
  return table.filter((entry) => entry.command.includes(marker) && entry.pid !== process.pid)
}

function processTable(): ProcessInfo[] {
  return parseProcessTable(execFileSync('ps', ['-A', '-o', 'pid=,pgid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }))
}

/**
 * What `ps -o lstart= -p <pid>` says about a PID. Only "exit status 1 and no output" means there is
 * no such process; any other failure (spawn error, timeout, a signal) proves nothing, and treating it
 * as "gone" could make a recovering run kill a live run and drop its database.
 */
export type ProcessState = { kind: 'running'; startedAt: string } | { kind: 'gone' } | { kind: 'unknown' }

export function readPsResult(result: { status: number | null; stdout: string; error?: Error }): ProcessState {
  const output = result.stdout.trim()
  if (result.error || result.status === null) return { kind: 'unknown' }
  if (result.status === 0 && output) return { kind: 'running', startedAt: output }
  if (result.status === 1 && !output) return { kind: 'gone' }
  return { kind: 'unknown' }
}

/** Whether the process exists and when it started; the start time tells a PID's owner apart from a later reuse. */
export function processState(pid: number): ProcessState {
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 })
  return readPsResult({ status: result.status, stdout: result.stdout ?? '', error: result.error })
}

function killProcess(target: number): void {
  try {
    process.kill(target, 'SIGKILL')
  } catch {
    // Already gone, or not a group leader.
  }
}

function killGroupAndLeader(pid: number): void {
  killProcess(-pid)
  killProcess(pid)
}

/**
 * Kills what a dead run left running, with the process groups they lead (our services are group
 * leaders, so their unmarked children, e.g. the Go `turbo` binary, go too):
 * - every process whose command line carries the run's guard (`parent-guard.mjs?run=<id>`);
 * - every recorded service whose PID still has the recorded start time. This covers `next start`,
 *   which renames itself to `next-server (v…)` and so loses the marker from its command line.
 * Returns how many processes were killed.
 */
export async function killRunProcesses(runId: string, services: Array<{ pid?: number; startedAt?: string }> = []): Promise<number> {
  const marked = processesOfRun(processTable(), runId)
  for (const entry of marked) {
    if (entry.pgid === entry.pid) killGroupAndLeader(entry.pid)
    else killProcess(entry.pid)
  }
  let recorded = 0
  for (const service of services) {
    if (!service.pid || !service.startedAt || marked.some((entry) => entry.pid === service.pid)) continue
    const state = processState(service.pid)
    if (state.kind === 'running' && state.startedAt === service.startedAt) {
      killGroupAndLeader(service.pid)
      recorded++
    }
  }
  for (let attempt = 0; attempt < 20 && processesOfRun(processTable(), runId).length > 0; attempt++) await sleep(100)
  const left = processesOfRun(processTable(), runId)
  if (left.length > 0) throw new Error(`Processes of e2e run ${runId} survived SIGKILL: ${left.map((entry) => entry.pid).join(', ')}`)
  return marked.length + recorded
}
