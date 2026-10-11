// Test and recording tooling only: never imported by the connector itself.
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createReplayFetch, loadCassette, openCassette } from '@hanza/connector-sdk/testing'
import { authorization } from '../client'
import type { WooCommerceContext, WooCommerceCredentials } from '../settings'
import { loadRecording, RECORDING_STORE_URL, replayConfig, replayCredentials, unauthorizedCredentials, type WooCommerceRecording } from './recording'
import { woocommerceScrub } from './scrub'

// What the scenario helpers share (`offer-scenario.ts`, `orders-scenario.ts`): a cassette that is replayed or, with
// `HANZA_RECORD_FIXTURES=1`, recorded from the sandbox shop; the sandbox itself, to put the shop in the state a
// scenario needs; and the check that the cassette held exactly the requests that were sent.

/**
 * The sandbox shop while a scenario is recorded. Nothing done through it reaches the cassette: it talks to the shop
 * directly, with the read-write key.
 */
export interface Sandbox {
  get(path: string): Promise<Record<string, unknown>>
  /** Resolves with the created resource's id. */
  post(path: string, body: unknown): Promise<number>
  put(path: string, body: unknown): Promise<void>
  /** `DELETE` without `force`: for an order, into the trash. */
  trash(path: string): Promise<void>
  /** `sandbox.sh wp <args>`, for what the REST API cannot do. A few seconds per call: give the test a timeout. */
  wp(...args: string[]): Promise<void>
  /** `sandbox.sh wp eval <php>`. */
  php(code: string): Promise<void>
}

/** The sandbox's keys: read and write, read only (401 on a write), a subscriber's (403 everywhere), and one the shop does not know (401). */
export type SandboxKey = 'readWrite' | 'readOnly' | 'noCapability' | 'unknown'

export interface ScenarioLog {
  message: string
  fields?: Record<string, unknown>
}

export interface ScenarioRun {
  /** True while the cassette is being recorded. */
  recording: boolean
  /** The sandbox while recording; null on replay. */
  sandbox: Sandbox | null
  /** A capability context answered by the cassette, or by the sandbox while recording. */
  context(key?: SandboxKey): WooCommerceContext
  /** What the capability logged. */
  logs: ScenarioLog[]
  /** The requests sent so far, as `METHOD path?query`. */
  requests: string[]
  /** The JSON bodies sent so far, in order (a GET has none). */
  bodies: unknown[]
}

export interface ScenarioHooks {
  /** Recording only: puts the shop in the state the scenario starts from. */
  prepare?(sandbox: Sandbox): Promise<void>
  /** Recording only: undoes `prepare`, also when the scenario failed. */
  restore?(sandbox: Sandbox): Promise<void>
  /**
   * Replays the cassette another scenario records, also while recording, to ask the same shop in another way: an
   * answer may then be used more than once or not at all. Put such a test after the one that records.
   */
  reuse?: boolean
}

const SANDBOX_SCRIPT = fileURLToPath(new URL('../../sandbox/sandbox.sh', import.meta.url))

export function assertSandboxPort(): void {
  // The script falls back to the default instance's port, and compose would then move this one onto it.
  if (process.env.WOO_SANDBOX_PROJECT !== undefined && process.env.WOO_SANDBOX_PORT === undefined) {
    throw new Error('Set WOO_SANDBOX_PORT next to WOO_SANDBOX_PROJECT (see sandbox/README.md, "Two shops at once").')
  }
}

async function runSandboxScript(...args: string[]): Promise<void> {
  assertSandboxPort()
  await promisify(execFile)(SANDBOX_SCRIPT, args)
}

export function sandboxOf(recording: WooCommerceRecording): Sandbox {
  const send = async (method: string, path: string, body?: unknown): Promise<Record<string, unknown>> => {
    const response = await recording.fetch(`${RECORDING_STORE_URL}/wp-json/wc/v3/${path}`, {
      method,
      headers: { accept: 'application/json', authorization: authorization(recording.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    // The status only: a body could carry a key back into the test output.
    if (!response.ok) throw new Error(`The sandbox answered ${response.status} to ${method} ${path}`)
    return (await response.json()) as Record<string, unknown>
  }
  return {
    get: (path) => send('GET', path),
    post: async (path, body) => Number((await send('POST', path, body)).id),
    put: async (path, body) => {
      await send('PUT', path, body)
    },
    trash: async (path) => {
      await send('DELETE', path)
    },
    wp: (...args) => runSandboxScript('wp', ...args),
    php: (code) => runSandboxScript('wp', 'eval', code),
  }
}

/**
 * Runs `run` against `src/fixtures/<name>.cassette.json`, or records that cassette from the sandbox when
 * `HANZA_RECORD_FIXTURES=1` (`prepare` first, `restore` afterwards). Fails when the cassette had no answer for a
 * request or holds one nobody asked for. A recording is written only when `run` passed.
 */
export async function runScenario(name: string, run: (scenario: ScenarioRun) => Promise<void>, hooks: ScenarioHooks = {}): Promise<void> {
  const file = new URL(`../fixtures/${name}.cassette.json`, import.meta.url)
  const secrets = Object.values(replayCredentials)
  let loaded: WooCommerceRecording | null = null
  const cassette = hooks.reuse
    ? { ...createReplayFetch(await loadCassette(file), { scrub: woocommerceScrub, secrets, name }), close: async () => {} }
    : await openCassette(file, { scrub: woocommerceScrub, secrets, recording: async () => (loaded = await loadRecording()) })
  // Assigned in a callback, which the compiler does not follow.
  const recording = loaded as WooCommerceRecording | null
  const sandbox = recording === null ? null : sandboxOf(recording)
  // On replay the key does not matter: the cassette holds what the shop answered to the recorded one.
  const keyOf = (key: SandboxKey): WooCommerceCredentials => {
    if (recording === null) return replayCredentials
    return { readWrite: recording.credentials, readOnly: recording.readOnlyCredentials, noCapability: recording.noCapabilityCredentials, unknown: unauthorizedCredentials }[key]
  }

  const scenario: ScenarioRun = {
    recording: sandbox !== null,
    sandbox,
    logs: [],
    requests: [],
    bodies: [],
    context: (key = 'readWrite') => ({
      app: {},
      config: replayConfig,
      credentials: keyOf(key),
      fetch: (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        scenario.requests.push(`${init?.method ?? 'GET'} ${url.pathname.replace('/wp-json/wc/v3/', '')}${decodeURIComponent(url.search)}`)
        if (typeof init?.body === 'string') scenario.bodies.push(JSON.parse(init.body))
        return cassette.fetch(input, init)
      },
      log: (message, fields) => {
        scenario.logs.push(fields === undefined ? { message } : { message, fields })
      },
    }),
  }

  try {
    if (sandbox !== null) await hooks.prepare?.(sandbox)
    await run(scenario)
    if (cassette.misses.length > 0) throw new Error(`${name}: the cassette has no answer for\n${cassette.misses.join('\n')}`)
    const unused = hooks.reuse ? [] : cassette.unused()
    if (unused.length > 0) throw new Error(`${name}: the cassette holds answers nobody asked for\n${unused.join('\n')}`)
    await cassette.close()
  } finally {
    if (sandbox !== null) await hooks.restore?.(sandbox)
  }
}
