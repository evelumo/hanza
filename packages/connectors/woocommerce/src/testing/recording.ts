// Test and recording tooling only: never imported by the connector itself.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { WooCommerceConfig, WooCommerceCredentials } from '../settings'
import { woocommerceScrub } from './scrub'

/**
 * The address every cassette is recorded and replayed under. The sandbox shop is installed under this address
 * too, so its links (`permalink`, `_links`, the `Link` header) never name the machine or port it ran on.
 */
export const RECORDING_STORE_URL = 'https://shop.example.test'

/** What a test replays with: the neutral address, and stand-ins for the recorded keys (never real ones). */
export const replayConfig: WooCommerceConfig = { storeUrl: RECORDING_STORE_URL }
export const replayCredentials: WooCommerceCredentials = {
  consumerKey: 'ck_replay_consumer_key',
  consumerSecret: 'cs_replay_consumer_secret',
}
/** Keys WooCommerce refuses with 401, for the `unauthorized` cassette; sent as they are when recording. */
export const unauthorizedCredentials: WooCommerceCredentials = {
  consumerKey: 'ck_unknown_consumer_key',
  consumerSecret: 'cs_unknown_consumer_secret',
}

const DEFAULT_PROJECT = 'hanza-woo-sandbox'
/** The sandbox instance to record from (`sandbox/sandbox.sh` reads the same variable); unset for the default one. */
const PROJECT_ENV = 'WOO_SANDBOX_PROJECT'

interface CredentialsFile {
  /** Where the sandbox listens, e.g. `http://127.0.0.1:8089`. */
  sandboxUrl: string
  consumerKey: string
  consumerSecret: string
  /** A key that may only read: 401 on a write. */
  readOnly: WooCommerceCredentials
  /** A key of a user who may not manage the shop: 403 on every route. */
  noCapability: WooCommerceCredentials
}

export interface WooCommerceRecording {
  config: WooCommerceConfig
  /** The sandbox's read-write key. */
  credentials: WooCommerceCredentials
  readOnlyCredentials: WooCommerceCredentials
  noCapabilityCredentials: WooCommerceCredentials
  /** Sends requests for `RECORDING_STORE_URL` to the local sandbox. */
  fetch: typeof fetch
  /** Every key of the sandbox, so none of them reaches a cassette whichever a scenario uses. */
  secrets: string[]
}

function credentialsPath(project: string): string {
  const name = project === DEFAULT_PROJECT ? 'credentials.json' : `credentials.${project}.json`
  return fileURLToPath(new URL(`../../.recording/${name}`, import.meta.url))
}

function isJson(response: Response): boolean {
  return /[/+]json\b/i.test(response.headers.get('content-type') ?? '')
}

const normalize = (name: string) => name.toLowerCase().replace(/[-_\s]/g, '')

/**
 * `''` under a key the scrub config declares becomes null. WooCommerce sends `''` for every field a Buyer left
 * out, and the recorder's scrubber replaces any string under a declared key, the empty one included: the empty
 * shipping address of virtual goods would come back from a cassette filled with placeholders. The connector reads
 * null and `''` alike, so a recording keeps what the shop meant.
 */
export function blanksToNull(value: unknown, keys: ReadonlySet<string> = new Set(Object.keys(woocommerceScrub.keys ?? {}).map(normalize))): unknown {
  if (Array.isArray(value)) return value.map((item) => blanksToNull(item, keys))
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, item === '' && keys.has(normalize(key)) ? null : blanksToNull(item, keys)]),
  )
}

/** A transport that answers requests for `RECORDING_STORE_URL` from the sandbox at `sandboxUrl`. */
export function sandboxFetch(sandboxUrl: string, transport: typeof fetch = fetch): typeof fetch {
  const storeOrigin = new URL(RECORDING_STORE_URL).origin
  return async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.origin !== storeOrigin) throw new Error(`The recording transport only forwards ${storeOrigin}, not ${url.origin}`)
    const headers = new Headers(request.headers)
    // WooCommerce accepts API keys only over TLS; the official WordPress image takes this header's word for it.
    headers.set('x-forwarded-proto', 'https')
    const response = await transport(new URL(`${url.pathname}${url.search}`, sandboxUrl), {
      method: request.method,
      headers,
      body: request.body === null ? undefined : await request.arrayBuffer(),
      redirect: 'manual',
      signal: request.signal,
    })
    if (!isJson(response)) return response
    const text = await response.text()
    let body = text
    try {
      body = JSON.stringify(blanksToNull(JSON.parse(text)))
    } catch {
      // Not JSON after all: pass it on as it came.
    }
    const responseHeaders = new Headers(response.headers)
    responseHeaders.delete('content-length')
    responseHeaders.delete('content-encoding')
    return new Response(body, { status: response.status, statusText: response.statusText, headers: responseHeaders })
  }
}

/**
 * The recording setup for `runConformance({ recording })` and `openCassette({ recording })`: the sandbox's keys from
 * the git-ignored `.recording/` (written by `sandbox/sandbox.sh key`) and a transport to the sandbox. Called only
 * when recording, so a replay never needs the file.
 */
export async function loadRecording(project = process.env[PROJECT_ENV] ?? DEFAULT_PROJECT): Promise<WooCommerceRecording> {
  const path = credentialsPath(project)
  let file: CredentialsFile
  try {
    file = JSON.parse(await readFile(path, 'utf8')) as CredentialsFile
  } catch (error) {
    throw new Error(`No sandbox keys at ${path}: run "sandbox/sandbox.sh up", "seed" and "key" first (see sandbox/README.md).`, { cause: error })
  }
  const credentials = { consumerKey: file.consumerKey, consumerSecret: file.consumerSecret }
  return {
    config: replayConfig,
    credentials,
    readOnlyCredentials: file.readOnly,
    noCapabilityCredentials: file.noCapability,
    fetch: sandboxFetch(file.sandboxUrl),
    secrets: [credentials, file.readOnly, file.noCapability].flatMap((key) => [key.consumerKey, key.consumerSecret]),
  }
}
