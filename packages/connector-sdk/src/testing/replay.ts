import { bodyHash, bodyToBytes, encodeBody, headersToRecord, sortedParams, type Cassette, type CassetteInteraction } from './cassette'
import { Scrubber, type ScrubConfig } from './scrub'

export interface MatchOptions {
  /** Request headers that must match as well (they must be kept by the scrub config). Default: none. */
  headers?: string[]
  /** Query parameters left out of the comparison (timestamps, nonces). */
  ignoreQueryParams?: string[]
  /** Compare request bodies by the SHA-256 of their scrubbed, canonical form. Default true. */
  body?: boolean
  /** When every recorded response for a request was served: repeat the last one (default) or fail. */
  exhausted?: 'repeat-last' | 'error'
}

export interface ReplayOptions {
  match?: MatchOptions
  /** The config the cassette was recorded with, so incoming requests are scrubbed the same way before matching. */
  scrub?: ScrubConfig
  /** Values the test sends that stand for recorded secrets, typically the test's credentials. */
  secrets?: Iterable<string>
  /** Shown in errors, e.g. the cassette's file name. */
  name?: string
}

export interface ReplayFetch {
  fetch: typeof fetch
  /** Every request that matched nothing (each also threw `CassetteMissError`). */
  readonly misses: readonly string[]
  /** Recorded interactions that were never served, as `METHOD url`. */
  unused(): string[]
}

/** A request the cassette has no answer for. The message names method and scrubbed URL only, never headers or bodies. */
export class CassetteMissError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CassetteMissError'
  }
}

interface RequestKey {
  method: string
  origin: string
  path: string
  params: URLSearchParams
  query: string
  body: string | null
  headers: Record<string, string | null>
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

function keyOf(request: CassetteInteraction['request'], match: MatchOptions): RequestKey {
  const url = new URL(request.url)
  const ignored = new Set(match.ignoreQueryParams ?? [])
  const params = new URLSearchParams([...url.searchParams.entries()].filter(([name]) => !ignored.has(name)))
  return {
    method: request.method.toUpperCase(),
    origin: url.origin,
    path: url.pathname,
    params,
    query: sortedParams(params),
    body: match.body === false ? null : bodyHash(request.body, request.headers['content-type'] ?? null),
    headers: Object.fromEntries((match.headers ?? []).map((name) => [name.toLowerCase(), request.headers[name.toLowerCase()] ?? null])),
  }
}

function serialize(key: RequestKey): string {
  return JSON.stringify([key.method, key.origin, key.path, key.query, key.body, key.headers])
}

function differences(a: RequestKey, b: RequestKey): { score: number; labels: string[] } {
  const labels: string[] = []
  let score = 0
  if (a.method !== b.method) {
    labels.push('method')
    score += 8
  }
  if (a.origin !== b.origin) {
    labels.push('host')
    score += 8
  }
  if (a.path !== b.path) {
    const left = a.path.split('/')
    const right = b.path.split('/')
    const changed = Math.max(left.length, right.length) - left.filter((segment, index) => segment === right[index]).length
    labels.push('path')
    score += 2 + changed
  }
  const names = new Set([...a.params.keys(), ...b.params.keys()])
  const query = [...names].filter((name) => a.params.getAll(name).join('\u0000') !== b.params.getAll(name).join('\u0000')).sort()
  if (query.length > 0) {
    labels.push(`query ${query.map((name) => `"${name}"`).join(', ')}`)
    score += query.length
  }
  if (a.body !== b.body) {
    labels.push('body')
    score += 2
  }
  const headers = Object.keys(a.headers).filter((name) => a.headers[name] !== b.headers[name])
  if (headers.length > 0) {
    labels.push(`header ${headers.map((name) => `"${name}"`).join(', ')}`)
    score += headers.length
  }
  return { score, labels }
}

function toBodyInit(interaction: CassetteInteraction['response']): ArrayBuffer | null {
  if (NULL_BODY_STATUSES.has(interaction.status)) return null
  const bytes = bodyToBytes(interaction.body)
  return bytes === null ? null : (bytes.slice().buffer as ArrayBuffer)
}

/**
 * A `fetch` that answers from a cassette and never touches the network. Incoming requests are scrubbed
 * like the recording was, then matched on method, URL (query sorted) and body hash; identical requests
 * get the recorded responses in order.
 */
export function createReplayFetch(cassette: Cassette, options: ReplayOptions = {}): ReplayFetch {
  const match = options.match ?? {}
  const scrubber = new Scrubber(options.scrub, options.secrets)
  const label = options.name ? ` in ${options.name}` : ''
  const recorded = cassette.interactions.map((interaction) => {
    const key = keyOf(interaction.request, match)
    return { interaction, key, id: serialize(key) }
  })
  const groups = new Map<string, number[]>()
  recorded.forEach(({ id }, index) => groups.set(id, [...(groups.get(id) ?? []), index]))
  const served = new Map<string, number>()
  const used = new Set<number>()
  const misses: string[] = []

  const miss = (message: string): never => {
    misses.push(message)
    throw new CassetteMissError(message)
  }

  const replayFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    request.signal.throwIfAborted()
    const bytes = new Uint8Array(await request.arrayBuffer())
    const headers = headersToRecord(request.headers)
    const scrubbed = scrubber.interaction({
      request: { method: request.method, url: request.url, headers, body: encodeBody(bytes, headers['content-type'] ?? null) },
      response: { status: 200, headers: {}, body: null },
    }).request
    const key = keyOf(scrubbed, match)
    const id = serialize(key)
    const description = `${key.method} ${scrubbed.url}`
    const indices = groups.get(id)

    if (!indices) {
      const seen = new Set<string>()
      const nearest = recorded
        .flatMap(({ interaction, key: candidate, id: candidateId }, index) => {
          if (seen.has(candidateId)) return []
          seen.add(candidateId)
          return [{ interaction, index, ...differences(candidate, key) }]
        })
        .sort((a, b) => a.score - b.score || a.index - b.index)
        .slice(0, 3)
      const lines = nearest.map(
        ({ interaction, labels }, index) =>
          `  ${index + 1}. ${interaction.request.method.toUpperCase()} ${interaction.request.url} (differs in ${labels.join('; ')})`,
      )
      return miss(
        [
          `No recorded interaction${label} for ${description}.`,
          lines.length > 0 ? `Nearest recorded requests:\n${lines.join('\n')}` : 'The cassette has no interactions.',
          'If the connector changed its requests on purpose, record the cassette again (HANZA_RECORD_FIXTURES=1).',
        ].join('\n'),
      )
    }

    const count = served.get(id) ?? 0
    if (count >= indices.length && match.exhausted === 'error') {
      return miss(`All ${indices.length} recorded responses${label} for ${description} were already served.`)
    }
    served.set(id, count + 1)
    const index = indices[Math.min(count, indices.length - 1)]!
    used.add(index)
    const { response } = recorded[index]!.interaction
    return new Response(toBodyInit(response), { status: response.status, headers: response.headers })
  }

  return {
    fetch: replayFetch,
    misses,
    unused: () =>
      recorded
        .filter((_, index) => !used.has(index))
        .map(({ interaction }) => `${interaction.request.method.toUpperCase()} ${interaction.request.url}`),
  }
}
