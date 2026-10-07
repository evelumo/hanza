import { basename, join } from 'node:path'
import type { AnyConnectorDefinition, CapabilityContext } from '../connector'
import { CASSETTE_SUFFIX, loadCassette, toPath } from './cassette'
import { assertConformance } from './conformance'
import { createRecordingFetch } from './record'
import { createReplayFetch, type MatchOptions } from './replay'
import type { ScrubConfig } from './scrub'
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
 * The connector with `ctx.fetch` replaced in every capability, so a replayed (or recording) fetch reaches it
 * through the engine without the connector knowing.
 */
export function withFetch<T extends AnyConnectorDefinition>(connector: T, replacement: typeof fetch): T {
  const capabilities = Object.fromEntries(
    Object.entries(connector.capabilities).map(([name, run]) => [
      name,
      typeof run === 'function'
        ? (ctx: CapabilityContext, ...args: unknown[]) =>
            (run as (ctx: CapabilityContext, ...args: unknown[]) => unknown).call(connector.capabilities, { ...ctx, fetch: replacement }, ...args)
        : run,
    ]),
  )
  return { ...connector, capabilities } as T
}

export const CONFORMANCE_CASSETTE = `conformance${CASSETTE_SUFFIX}`
export const UNAUTHORIZED_CASSETTE = `conformance-unauthorized${CASSETTE_SUFFIX}`

export interface ConformanceRecordingSetup extends RecordingSetup {
  /** Real config and credentials for the sandbox. Default: the replay values. */
  config?: unknown
  credentials?: unknown
  /** Credentials the real API must refuse. Default: `unauthorized.credentials`. */
  unauthorizedCredentials?: unknown
}

export interface RunConformanceOptions extends LintOptions {
  /** Directory with `conformance.cassette.json` (and `conformance-unauthorized.cassette.json` for C11). */
  fixtures: string | URL
  /** Config and credentials the replay runs with; the credentials stand in for the recorded ones. */
  config: unknown
  credentials: unknown
  /** Enables check C11 against the unauthorized cassette. */
  unauthorized?: { credentials?: unknown }
  /** Skips check C14, only for a Channel that uses 403 for rejected credentials (say why in the connector's AGENTS.md). */
  forbidden?: false
  /** Enables check C18: an `orders.pull` cursor the API no longer has, answered in the main cassette. */
  expiredCursor?: string
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
  const mainFile = join(dir, CONFORMANCE_CASSETTE)
  const unauthorizedFile = join(dir, UNAUTHORIZED_CASSETTE)
  if (isRecording()) return recordConformance(connector, options, mainFile, unauthorizedFile)

  await assertNoSecrets(dir, { allow: options.allow })
  const secrets = [...stringsIn(options.credentials), ...stringsIn(options.unauthorized?.credentials)]
  const replay = (cassette: Awaited<ReturnType<typeof loadCassette>>, file: string) =>
    createReplayFetch(cassette, { match: options.match, scrub: options.scrub, secrets, name: basename(file) })
  const main = replay(await loadCassette(mainFile), mainFile)
  const unauthorized = options.unauthorized ? replay(await loadCassette(unauthorizedFile), unauthorizedFile) : null

  let failure: string | null = null
  try {
    await assertConformance(connector, {
      config: options.config,
      credentials: options.credentials,
      maxPages: options.maxPages,
      expiredCursor: options.expiredCursor,
      fetch: main.fetch,
      unauthorized: unauthorized ? { credentials: options.unauthorized?.credentials, fetch: unauthorized.fetch } : undefined,
      ...(options.forbidden === false ? { forbidden: false as const } : {}),
    })
  } catch (error) {
    failure = messageOf(error)
  }
  // A connector may wrap the miss in a TransientError, or swallow it; the miss itself says what went wrong.
  const misses = [...main.misses, ...(unauthorized?.misses ?? [])]
  if (failure !== null || misses.length > 0) {
    const parts = [failure ?? 'Connector conformance passed, but the connector sent requests the cassettes have no answer for.']
    if (misses.length > 0) parts.push(`Unmatched requests:\n${misses.join('\n\n')}`)
    throw new Error(parts.join('\n\n'))
  }
}

async function recordConformance(
  connector: AnyConnectorDefinition,
  options: RunConformanceOptions,
  mainFile: string,
  unauthorizedFile: string,
): Promise<void> {
  const setup = (await options.recording?.()) ?? {}
  const credentials = setup.credentials ?? options.credentials
  const unauthorizedCredentials = setup.unauthorizedCredentials ?? options.unauthorized?.credentials
  const recorder = (extra: unknown) =>
    createRecordingFetch({
      fetch: setup.fetch,
      scrub: options.scrub,
      secrets: [...(setup.secrets ?? []), ...stringsIn(credentials), ...stringsIn(extra)],
      allow: options.allow,
    })
  const main = recorder(undefined)
  const unauthorized = options.unauthorized ? recorder(unauthorizedCredentials) : null

  let failure: unknown = null
  try {
    await assertConformance(connector, {
      config: setup.config ?? options.config,
      credentials,
      maxPages: options.maxPages,
      expiredCursor: options.expiredCursor,
      fetch: main.fetch,
      unauthorized: unauthorized ? { credentials: unauthorizedCredentials, fetch: unauthorized.fetch } : undefined,
      ...(options.forbidden === false ? { forbidden: false as const } : {}),
    })
  } catch (error) {
    failure = error
  }
  try {
    // Written even when a check failed, so the recording can be inspected; never when the lint fails.
    await main.save(mainFile)
    await unauthorized?.save(unauthorizedFile)
  } finally {
    await setup.close?.()
  }
  if (failure !== null) throw failure
}
