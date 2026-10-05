import { execFileSync } from 'node:child_process'
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

/** When the process started (as `ps` prints it), or null when there is no such process. Tells a PID's owner apart from a later reuse. */
export function processStartTime(pid: number): string | null {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

/**
 * Kills every process of a run left behind by a runner that died, with the process groups they
 * lead (our services are group leaders, so their unmarked children, e.g. the Go `turbo` binary, go
 * too). Returns how many marked processes were found.
 */
export async function killRunProcesses(runId: string): Promise<number> {
  const found = processesOfRun(processTable(), runId)
  for (const entry of found) {
    for (const target of entry.pgid === entry.pid ? [-entry.pgid, entry.pid] : [entry.pid]) {
      try {
        process.kill(target, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
  }
  for (let attempt = 0; attempt < 20 && processesOfRun(processTable(), runId).length > 0; attempt++) await sleep(100)
  const left = processesOfRun(processTable(), runId)
  if (left.length > 0) throw new Error(`Processes of e2e run ${runId} survived SIGKILL: ${left.map((entry) => entry.pid).join(', ')}`)
  return found.length
}
