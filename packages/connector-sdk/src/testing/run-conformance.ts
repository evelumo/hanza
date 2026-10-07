import { basename, join } from 'node:path'
import type { AuthContext } from '../auth'
import type { AnyConnectorDefinition, CapabilityContext } from '../connector'
import { CASSETTE_SUFFIX, loadCassette, toPath } from './cassette'
import { assertConformance } from './conformance'
import { createRecordingFetch } from './record'
import { createReplayFetch, type MatchOptions } from './replay'
import { normalizeName, SECRET_NAMES, type ScrubConfig } from './scrub'
import { assertNoSecrets, type LintOptions } from './secrets-lint'

/** Set to `1` to record cassettes from the real API instead of replaying them. Never set in CI. */
export const RECORD_ENV = 'HANZA_RECORD_FIXTURES'

/** True when this run records. Throws when asked to record in CI: CI only replays. */
export function isRecording(env: Record<string, string | undefined> = process.env): boolean {
  if (env[RECORD_ENV] !== '1') return false
  if (env.CI !== undefined && env.CI !== '' && env.CI !== 'false' && env.CI !== '0') {
    throw new Error(`${RECORD_ENV} is set in CI. CI only replays recorded fixtures; record on a developer machine.`)
  }
  return true
}

/** What a test provides for recording; called only when recording, so replay never reads it. */
export interface RecordingSetup {
  /** The transport to the real API. Default: the global `fetch`. */
  fetch?: typeof fetch
  /** Secret values to scrub wherever they appear (credentials, a client secret). */
  secrets?: string[]
  /** Called after the cassette was written, e.g. to stop a server. */
  close?(): void | Promise<void>
}

export interface CassetteOptions extends LintOptions {
  scrub?: ScrubConfig
  match?: MatchOptions
  /** Values the test sends in place of recorded secrets (its credentials), scrubbed before matching. */
  secrets?: Iterable<string>
  recording?: () => RecordingSetup | Promise<RecordingSetup>
}

export interface OpenedCassette {
  mode: 'record' | 'replay'
  fetch: typeof fetch
  /** Requests the cassette had no answer for (replay only). */
  readonly misses: readonly string[]
  /** Recorded interactions never served (replay only). */
  unused(): string[]
  /** Replay: nothing. Record: scrubs, lints and writes the cassette, then runs the setup's `close`. */
  close(): Promise<void>
}

/** Replays `file`, or records it when `HANZA_RECORD_FIXTURES=1`. For scenario tests beyond the conformance kit. */
export async function openCassette(file: string | URL, options: CassetteOptions = {}): Promise<OpenedCassette> {
  if (isRecording()) {
    const setup = (await options.recording?.()) ?? {}
    const recorder = createRecordingFetch({
      fetch: setup.fetch,
      scrub: options.scrub,
      secrets: [...(options.secrets ?? []), ...(setup.secrets ?? [])],
      allow: options.allow,
    })
    return {
      mode: 'record',
      fetch: recorder.fetch,
      misses: [],
      unused: () => [],
      close: async () => {
        try {
          await recorder.save(file)
        } finally {
          await setup.close?.()
        }
      },
    }
  }
  const cassette = await loadCassette(file)
  await assertNoSecrets(cassette, { allow: options.allow, file: toPath(file) })
  const replay = createReplayFetch(cassette, {
    match: options.match,
    scrub: options.scrub,
    secrets: options.secrets,
    name: basename(toPath(file)),
  })
  return { mode: 'replay', fetch: replay.fetch, misses: replay.misses, unused: replay.unused, close: async () => {} }
}

/**
 * The connector with `ctx.fetch` replaced in every capability and every sign-in hook (`auth.refresh`,
 * `auth.deviceFlow`), so a replayed (or recording) fetch reaches it through the engine without the connector knowing.
 */
export function withFetch<T extends AnyConnectorDefinition>(connector: T, replacement: typeof fetch): T {
  type Hook = (ctx: CapabilityContext | AuthContext, ...args: unknown[]) => unknown
  const wrap = (owner: object, run: unknown) =>
    typeof run === 'function' ? (ctx: CapabilityContext | AuthContext, ...args: unknown[]) => (run as Hook).call(owner, { ...ctx, fetch: replacement }, ...args) : run
  const capabilities = Object.fromEntries(Object.entries(connector.capabilities).map(([name, run]) => [name, wrap(connector.capabilities, run)]))
  const { auth } = connector
  if (auth.type !== 'oauth2') return { ...connector, capabilities } as T
  const deviceFlow = auth.deviceFlow && {
    ...auth.deviceFlow,
    start: wrap(auth.deviceFlow, auth.deviceFlow.start),
    poll: wrap(auth.deviceFlow, auth.deviceFlow.poll),
  }
  const wrappedAuth = { ...auth, ...(auth.refresh ? { refresh: wrap(auth, auth.refresh) } : {}), ...(deviceFlow ? { deviceFlow } : {}) }
  return { ...connector, capabilities, auth: wrappedAuth } as T
}

export const CONFORMANCE_CASSETTE = `conformance${CASSETTE_SUFFIX}`
export const UNAUTHORIZED_CASSETTE = `conformance-unauthorized${CASSETTE_SUFFIX}`
/** `auth.refresh` of the credentials (check C14). */
export const REFRESH_CASSETTE = `conformance-refresh${CASSETTE_SUFFIX}`
/** `auth.refresh` the Channel refuses (check C14). */
export const REFRESH_REFUSED_CASSETTE = `conformance-refresh-refused${CASSETTE_SUFFIX}`
/** `auth.deviceFlow.start`, then one `poll` (check C15). */
export const DEVICE_FLOW_CASSETTE = `conformance-device-flow${CASSETTE_SUFFIX}`

export interface ConformanceRecordingSetup extends RecordingSetup {
  /** Real installation settings, config and credentials for the sandbox. Default: the replay values. */
  app?: unknown
  config?: unknown
  credentials?: unknown
  /** Credentials the real API must refuse. Default: `unauthorized.credentials`. */
  unauthorizedCredentials?: unknown
  /** Credentials whose refresh the real API must refuse. Default: `refresh.refused.credentials`. */
  refusedRefreshCredentials?: unknown
}

export interface RunConformanceOptions extends LintOptions {
  /** Directory with `conformance.cassette.json` (and `conformance-unauthorized.cassette.json` for C11). */
  fixtures: string | URL
  /**
   * Installation settings (`appConfigSchema`) the replay runs with. Their secret fields (names the scrubber treats as
   * secret, such as `clientSecret`, plus `appSecrets`) are scrubbed wherever they appear, like credentials.
   */
  app?: unknown
  /** More `app` field names whose values are secret. */
  appSecrets?: string[]
  /** Config and credentials the replay runs with; the credentials stand in for the recorded ones. */
  config: unknown
  credentials: unknown
  /** Enables check C11 against the unauthorized cassette. */
  unauthorized?: { credentials?: unknown }
  /**
   * Required for a connector with `auth.refresh`: check C14 against `conformance-refresh.cassette.json`, and with
   * `refused` against `conformance-refresh-refused.cassette.json`.
   */
  refresh?: { refused?: { credentials: unknown } }
  /** Required for a connector with `auth.deviceFlow`: check C15 against `conformance-device-flow.cassette.json`. */
  deviceFlow?: boolean
  maxPages?: number
  scrub?: ScrubConfig
  match?: MatchOptions
  /** Loads the real config, credentials and transport from a git-ignored place. Called only when recording. */
  recording?: () => ConformanceRecordingSetup | Promise<ConformanceRecordingSetup>
}

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(stringsIn)
  return []
}

/** String values of `app` fields that are secret: never written to a cassette, replaced before matching. */
function appSecretValues(app: unknown, extra: readonly string[] = []): string[] {
  if (app === null || typeof app !== 'object') return []
  const wanted = new Set(extra.map(normalizeName))
  return Object.entries(app as Record<string, unknown>)
    .filter(([key]) => SECRET_NAMES.has(normalizeName(key)) || wanted.has(normalizeName(key)))
    .flatMap(([, value]) => stringsIn(value))
}

type Files = { main: string; unauthorized: string; refresh: string; refreshRefused: string; deviceFlow: string }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The conformance kit (`assertConformance`) against recorded fixtures: lints the directory, replays the
 * cassettes and reports requests they had no answer for. With `HANZA_RECORD_FIXTURES=1` it runs the kit
 * against the real API instead and writes the scrubbed cassettes.
 */
export async function runConformance(connector: AnyConnectorDefinition, options: RunConformanceOptions): Promise<void> {
  const dir = toPath(options.fixtures)
  const files: Files = {
    main: join(dir, CONFORMANCE_CASSETTE),
    unauthorized: join(dir, UNAUTHORIZED_CASSETTE),
    refresh: join(dir, REFRESH_CASSETTE),
    refreshRefused: join(dir, REFRESH_REFUSED_CASSETTE),
    deviceFlow: join(dir, DEVICE_FLOW_CASSETTE),
  }
  if (isRecording()) return recordConformance(connector, options, files)

  await assertNoSecrets(dir, { allow: options.allow })
  const secrets = [
    ...stringsIn(options.credentials),
    ...stringsIn(options.unauthorized?.credentials),
    ...stringsIn(options.refresh?.refused?.credentials),
    ...appSecretValues(options.app, options.appSecrets),
  ]
  const replay = async (file: string) =>
    createReplayFetch(await loadCassette(file), { match: options.match, scrub: options.scrub, secrets, name: basename(file) })
  const main = await replay(files.main)
  const unauthorized = options.unauthorized ? await replay(files.unauthorized) : null
  const refresh = options.refresh ? await replay(files.refresh) : null
  const refreshRefused = options.refresh?.refused ? await replay(files.refreshRefused) : null
  const deviceFlow = options.deviceFlow ? await replay(files.deviceFlow) : null

  let failure: string | null = null
  try {
    await assertConformance(connector, {
      app: options.app,
      config: options.config,
      credentials: options.credentials,
      maxPages: options.maxPages,
      fetch: main.fetch,
      unauthorized: unauthorized ? { credentials: options.unauthorized?.credentials, fetch: unauthorized.fetch } : undefined,
      refresh: refresh
        ? {
            fetch: refresh.fetch,
            refused: refreshRefused ? { credentials: options.refresh?.refused?.credentials, fetch: refreshRefused.fetch } : undefined,
          }
        : undefined,
      deviceFlow: deviceFlow ? { fetch: deviceFlow.fetch } : undefined,
    })
  } catch (error) {
    failure = messageOf(error)
  }
  // A connector may wrap the miss in a TransientError, or swallow it; the miss itself says what went wrong.
  const misses = [main, unauthorized, refresh, refreshRefused, deviceFlow].flatMap((replayed) => replayed?.misses ?? [])
  if (failure !== null || misses.length > 0) {
    const parts = [failure ?? 'Connector conformance passed, but the connector sent requests the cassettes have no answer for.']
    if (misses.length > 0) parts.push(`Unmatched requests:\n${misses.join('\n\n')}`)
    throw new Error(parts.join('\n\n'))
  }
}

async function recordConformance(connector: AnyConnectorDefinition, options: RunConformanceOptions, files: Files): Promise<void> {
  const setup = (await options.recording?.()) ?? {}
  const app = setup.app ?? options.app
  const credentials = setup.credentials ?? options.credentials
  const unauthorizedCredentials = setup.unauthorizedCredentials ?? options.unauthorized?.credentials
  const refusedCredentials = setup.refusedRefreshCredentials ?? options.refresh?.refused?.credentials
  const recorder = (extra: unknown) =>
    createRecordingFetch({
      fetch: setup.fetch,
      scrub: options.scrub,
      secrets: [...(setup.secrets ?? []), ...stringsIn(credentials), ...appSecretValues(app, options.appSecrets), ...stringsIn(extra)],
      allow: options.allow,
    })
  const main = recorder(undefined)
  const unauthorized = options.unauthorized ? recorder(unauthorizedCredentials) : null
  const refresh = options.refresh ? recorder(undefined) : null
  const refreshRefused = options.refresh?.refused ? recorder(refusedCredentials) : null
  const deviceFlow = options.deviceFlow ? recorder(undefined) : null

  let failure: unknown = null
  try {
    await assertConformance(connector, {
      app,
      config: setup.config ?? options.config,
      credentials,
      maxPages: options.maxPages,
      fetch: main.fetch,
      unauthorized: unauthorized ? { credentials: unauthorizedCredentials, fetch: unauthorized.fetch } : undefined,
      refresh: refresh
        ? { fetch: refresh.fetch, refused: refreshRefused ? { credentials: refusedCredentials, fetch: refreshRefused.fetch } : undefined }
        : undefined,
      deviceFlow: deviceFlow ? { fetch: deviceFlow.fetch } : undefined,
    })
  } catch (error) {
    failure = error
  }
  try {
    // Written even when a check failed, so the recording can be inspected; never when the lint fails.
    await main.save(files.main)
    await unauthorized?.save(files.unauthorized)
    await refresh?.save(files.refresh)
    await refreshRefused?.save(files.refreshRefused)
    await deviceFlow?.save(files.deviceFlow)
  } finally {
    await setup.close?.()
  }
  if (failure !== null) throw failure
}
