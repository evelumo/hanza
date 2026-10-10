// Test and recording tooling only: never imported by the connector itself.
import type { WooCommerceContext } from '../settings'
import { runScenario, type Sandbox, type SandboxKey, type ScenarioLog } from './sandbox'

// A scenario of the Order feed or of a status push, replayed from `src/fixtures/<name>.cassette.json` or recorded
// from the sandbox shop (`HANZA_RECORD_FIXTURES=1`, see sandbox/README.md). Unlike a plain cassette test it can
// change the shop between two calls of the capability while it records (an order is paid, closed, trashed): those
// changes go to the sandbox directly, never through the recorder, and are skipped on replay.

export type { Sandbox }
export type ScenarioKey = SandboxKey

export interface OrdersScenario {
  /** True while the cassette is being recorded. */
  recording: boolean
  /** A capability context answered by the cassette, or by the sandbox while recording. */
  context(key?: ScenarioKey): WooCommerceContext
  /** What the capability logged. */
  logs: ScenarioLog[]
  /** The requests sent so far, as `METHOD path?query`. */
  requests: string[]
  /** Recording only: changes the shop behind the recorder's back. Skipped on replay, where the cassette already holds what followed. */
  change(act: (sandbox: Sandbox) => Promise<void>): Promise<void>
  /** Recording only: waits until the second of the last change is over, so a feed with a hold-back of 0 reads it. */
  settle(): Promise<void>
}

const SETTLE_MS = 2100

/** Runs `run` against the cassette `name`, or records it: see `runScenario` (`sandbox.ts`). */
export function withOrdersScenario(name: string, run: (scenario: OrdersScenario) => Promise<void>): Promise<void> {
  return runScenario(name, (shared) =>
    run({
      recording: shared.recording,
      context: shared.context,
      logs: shared.logs,
      requests: shared.requests,
      change: async (act) => {
        if (shared.sandbox !== null) await act(shared.sandbox)
      },
      settle: async () => {
        if (shared.recording) await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
      },
    }),
  )
}
