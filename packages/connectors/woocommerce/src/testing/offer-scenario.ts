// Test and recording tooling only: never imported by the connector itself.
import type { WooCommerceContext } from '../settings'
import { runScenario, type Sandbox, type SandboxKey, type ScenarioHooks, type ScenarioLog } from './sandbox'

export type { Sandbox, SandboxKey }
export type ScenarioSetup = ScenarioHooks

export interface Scenario {
  /** A capability context whose requests the cassette answers; while recording, the sandbox does and they are recorded. */
  context(key?: SandboxKey): WooCommerceContext
  /** What the capability logged. */
  logs: ScenarioLog[]
  /** The requests sent so far, as `METHOD path?query`. */
  requests: string[]
  /** The JSON bodies sent so far, in order (a GET has none). */
  bodies: unknown[]
}

/** A scenario of `offers.pull` or `stock.push`: see `runScenario` (`sandbox.ts`). */
export function withScenario(name: string, run: (scenario: Scenario) => Promise<void>, setup: ScenarioSetup = {}): Promise<void> {
  return runScenario(name, (scenario) => run(scenario), setup)
}
