// Test and recording tooling only: never imported by the connector itself.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { MedusaConfig, MedusaCredentials } from '../settings'
import { medusaScrub } from './scrub'

/**
 * The address every cassette is recorded and replayed under. Requests to it are sent to the local sandbox while
 * recording, so no cassette names the machine or port the sandbox ran on.
 */
export const RECORDING_STORE_URL = 'https://medusa.example.test'

/** What a test replays with: the neutral address, and a stand-in for the recorded key (never a real one). */
export const replayConfig: MedusaConfig = { storeUrl: RECORDING_STORE_URL }
export const replayCredentials: MedusaCredentials = { apiKey: 'sk_replay_secret_key_for_tests' }
/** A key the store does not know (401), for the `unauthorized` cassette; sent as it is when recording. */
export const unauthorizedCredentials: MedusaCredentials = { apiKey: 'sk_unknown_secret_key_for_tests' }

/**
 * Where a recording comes from: `sandbox` (default) is the Medusa in `sandbox/`, with the key `sandbox.sh key` wrote to
 * `.recording/credentials.json`; `fake` is the in-memory store of `src/testing/fake-medusa.ts`, which made the
 * provisional cassettes (AGENTS.md, "Tests and cassettes").
 */
export const RECORDING_SOURCE_ENV = 'MEDUSA_RECORDING_SOURCE'

interface CredentialsFile {
  /** Where the sandbox listens, e.g. `http://127.0.0.1:9100`. */
  sandboxUrl: string
  apiKey: string
}

export interface MedusaRecording {
  config: MedusaConfig
  credentials: MedusaCredentials
  /** Sends requests for `RECORDING_STORE_URL` to the store recorded from. */
  fetch: typeof fetch
  secrets: string[]
}

const normalize = (name: string) => name.toLowerCase().replace(/[-_\s]/g, '')

/**
 * `''` under a key the scrub config declares becomes null. Medusa stores `''` for an address field a Buyer left out,
 * and the recorder's scrubber replaces any string under a declared key, the empty one included (#128): an empty
 * `company` would come back from a cassette filled in. The connector reads null and `''` alike.
 */
export function blanksToNull(value: unknown, keys: ReadonlySet<string> = new Set(Object.keys(medusaScrub.keys ?? {}).map(normalize))): unknown {
  if (Array.isArray(value)) return value.map((item) => blanksToNull(item, keys))
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item === '' && keys.has(normalize(key)) ? null : blanksToNull(item, keys)]))
}

/** A transport that answers requests for `RECORDING_STORE_URL` from the sandbox at `sandboxUrl` (plain HTTP on this machine). */
export function sandboxFetch(sandboxUrl: string, transport: typeof fetch = fetch): typeof fetch {
  const storeOrigin = new URL(RECORDING_STORE_URL).origin
  return async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.origin !== storeOrigin) throw new Error(`The recording transport only forwards ${storeOrigin}, not ${url.origin}`)
    const response = await transport(new URL(`${url.pathname}${url.search}`, sandboxUrl), {
      method: request.method,
      headers: request.headers,
      body: request.body === null ? undefined : await request.arrayBuffer(),
      redirect: 'manual',
      signal: request.signal,
    })
    if (!/[/+]json\b/i.test(response.headers.get('content-type') ?? '')) return response
    const text = await response.text()
    let body = text
    try {
      body = JSON.stringify(blanksToNull(JSON.parse(text)))
    } catch {
      // Not JSON after all: pass it on as it came.
    }
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    headers.delete('content-encoding')
    return new Response(body, { status: response.status, statusText: response.statusText, headers })
  }
}

/**
 * The recording setup for `runConformance({ recording })` and `openCassette({ recording })`. Called only when
 * recording, so a replay never needs the file.
 */
export async function loadRecording(): Promise<MedusaRecording> {
  if (process.env[RECORDING_SOURCE_ENV] === 'fake') {
    const { conformanceStore } = await import('./conformance-store')
    const store = conformanceStore()
    return { config: replayConfig, credentials: replayCredentials, fetch: store.fetch, secrets: [replayCredentials.apiKey] }
  }
  const path = fileURLToPath(new URL('../../.recording/credentials.json', import.meta.url))
  let file: CredentialsFile
  try {
    file = JSON.parse(await readFile(path, 'utf8')) as CredentialsFile
  } catch (error) {
    throw new Error(`No sandbox key at ${path}: run "sandbox/sandbox.sh up", "seed" and "key" first (see sandbox/README.md).`, { cause: error })
  }
  return { config: replayConfig, credentials: { apiKey: file.apiKey }, fetch: sandboxFetch(file.sandboxUrl), secrets: [file.apiKey] }
}
