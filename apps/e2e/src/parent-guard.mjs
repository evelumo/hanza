// Preloaded (`node --import <this file>?run=<run id>`) into every process the e2e runner starts;
// plain JavaScript because it also runs in processes without a TypeScript loader (`next start`).
// The `?run=` query puts the run id on the command line, so a later run can recognise this run's
// processes with `ps` (see run-processes.ts). The runner holds the write end of this process's
// stdin and never writes to it: when the runner dies, even by SIGKILL, stdin ends, and the whole
// process group this process leads is killed, so nothing of a dead run keeps using Redis or Postgres.
import { fstatSync } from 'node:fs'
import process from 'node:process'

const ARMED = 'HANZA_E2E_GUARD_ARMED'

function stdinIsPipe() {
  try {
    const stat = fstatSync(0)
    return stat.isFIFO() || stat.isSocket()
  } catch {
    return false
  }
}

// Only the process the runner started watches its stdin. Its Node children inherit this preload
// through execArgv (Playwright's test workers do), but they have other stdins and must not react.
if (!process.env[ARMED] && stdinIsPipe()) {
  process.env[ARMED] = '1'
  const die = () => {
    try {
      process.kill(-process.pid, 'SIGKILL')
    } finally {
      process.exit(1)
    }
  }
  process.stdin.once('end', die)
  process.stdin.once('close', die)
  process.stdin.once('error', die)
  process.stdin.resume()
  // Watching stdin must not keep a process alive that is otherwise done (Playwright after the flows).
  process.stdin.unref?.()
}
