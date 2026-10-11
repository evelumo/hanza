import { isFormContentType, type CassetteBody, type CassetteInteraction } from './cassette'

/**
 * What a scrubbed value becomes: `secret` → `[scrubbed]`, `email` → `person-N@example.com`,
 * `phone` → `+000…N`, `text` → `scrubbed-N`. N is stable per value within one recording.
 */
export type ScrubKind = 'secret' | 'email' | 'phone' | 'text'

/** What a connector declares on top of the defaults; names are compared ignoring case, `-` and `_`. */
export interface ScrubConfig {
  /** JSON keys, anywhere in a body. A key whose value is an object or array scrubs every string below it. */
  keys?: Record<string, ScrubKind>
  /** Dotted JSON paths from the body root, e.g. `buyer.address.street`. Arrays are transparent; `*` is any key. */
  paths?: Record<string, ScrubKind>
  /** URL query and form-body parameters. */
  queryParams?: Record<string, ScrubKind>
  /** Every match, in any string (URLs, header values, text and JSON strings), is replaced. */
  patterns?: Array<{ pattern: RegExp; kind: ScrubKind }>
  /** Request headers kept besides `accept` and `content-type`. Authorization and cookie headers are never kept. */
  keepRequestHeaders?: string[]
  /** Response headers kept besides `content-type`, `retry-after`, `location` and `link`. `set-cookie` is never kept. */
  keepResponseHeaders?: string[]
  /** Binary bodies cannot be scrubbed, so they are dropped unless this is true. */
  keepBinaryBodies?: boolean
  /**
   * Puts a placeholder file where a binary body would be dropped: a blank one-page PDF for a PDF, the bytes of
   * `[scrubbed]` for anything else. For a response the connector must receive non-empty, such as a Label, which
   * prints a name and an address and so must not be kept. No effect with `keepBinaryBodies`.
   */
  replaceBinaryBodies?: boolean
}

export const SCRUBBED = '[scrubbed]'
/** Shorter values are not replaced literally everywhere: a 4-letter test key would match half the URLs. */
export const MIN_LITERAL_SECRET_LENGTH = 8

export const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie'])
const DEFAULT_REQUEST_HEADERS = ['accept', 'content-type']
const DEFAULT_RESPONSE_HEADERS = ['content-type', 'retry-after', 'location', 'link']

/** Keys and parameters whose value is always a secret (normalized: lower case, no `-` or `_`). */
export const SECRET_NAMES: ReadonlySet<string> = new Set([
  'accesstoken',
  'apikey',
  'apisecret',
  'authorization',
  'authtoken',
  'bearertoken',
  'clientid',
  'clientsecret',
  'codeverifier',
  'devicecode',
  'idtoken',
  'password',
  'privatekey',
  'refreshtoken',
  'secret',
  'sessionid',
  'sessiontoken',
  'token',
  'usercode',
  'xauthtoken',
])

/**
 * Secrets only as URL or form parameters (an OAuth `?code=`, a signed URL's `signature=`). As JSON keys they
 * usually hold error codes, currency codes or Offer signatures, which fixtures need.
 */
export const SECRET_PARAM_NAMES: ReadonlySet<string> = new Set([...SECRET_NAMES, 'code', 'signature'])

export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_\s]/g, '')
}

const RESERVED_TLDS = new Set(['example', 'test', 'invalid', 'localhost'])
/** RFC 2606 / 6761 names, which can never belong to a real person. */
export function isReservedEmailDomain(domain: string): boolean {
  const lower = domain.toLowerCase()
  return /(^|\.)example\.(com|net|org)$/.test(lower) || RESERVED_TLDS.has(lower.split('.').at(-1) ?? '')
}

export const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g
export const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g
// `+000…` is never a real country code, which is why the phone placeholder uses it.
export const PHONE_PATTERN = /(?<![\w+])\+(?!000)\d[\d \-()]{6,16}\d(?![\w])/g
const BEARER_PATTERN = /\b(Bearer)\s+(?!\[scrubbed\])([A-Za-z0-9\-._~+/]+=*)/gi
const BASIC_PATTERN = /\b(Basic)\s+(?!\[scrubbed\])([A-Za-z0-9+/]{8,}={0,2})/g
const PARAM_PATTERN = /([?&]|^)([A-Za-z][A-Za-z0-9_.-]*)=([^&#\s"'<>]*)/g

/** Basic credentials are base64 of `user:password`; "Basic shipping" in a text is not. */
export function isBasicCredential(token: string): boolean {
  try {
    return atob(token).includes(':')
  } catch {
    return false
  }
}

const PLACEHOLDER = /^(\[scrubbed\]|person-\d+@example\.com|\+000\d*|scrubbed-\d+)$/
export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value)
}

// Built, not pasted: the cross-reference table holds the byte offset of every object.
function blankPdf(): string {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 298 420] /Resources << >> >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((body, index) => {
    const offset = pdf.length
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
    return offset
  })
  const entries = offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  const size = objects.length + 1
  return `${pdf}xref\n0 ${size}\n0000000000 65535 f \n${entries}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${pdf.length}\n%%EOF\n`
}

/** What a binary body becomes under `replaceBinaryBodies`. */
export function binaryPlaceholder(contentType: string | null): CassetteBody {
  const text = /\bpdf\b/i.test(contentType ?? '') ? blankPdf() : SCRUBBED
  return { base64: Buffer.from(text, 'latin1').toString('base64') }
}

function lookup(table: Record<string, ScrubKind> | undefined): Map<string, ScrubKind> {
  return new Map(Object.entries(table ?? {}).map(([name, kind]) => [normalizeName(name), kind]))
}

function headerList(defaults: string[], extra: string[] | undefined, side: string): Set<string> {
  const names = [...defaults, ...(extra ?? [])].map((name) => name.toLowerCase())
  const forbidden = names.find((name) => FORBIDDEN_HEADERS.has(name))
  if (forbidden) throw new Error(`The ${side} header "${forbidden}" carries credentials and can never be kept in a cassette`)
  return new Set(names)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Replaces secrets and personal data in recorded interactions. Pure and deterministic: the same inputs in
 * the same order give the same placeholders. Values removed as secrets are learned and then replaced
 * literally everywhere else (a token from a token response that shows up in a later URL).
 */
export class Scrubber {
  readonly secrets = new Set<string>()
  private readonly keys: Map<string, ScrubKind>
  private readonly params: Map<string, ScrubKind>
  private readonly paths: Array<{ segments: string[]; kind: ScrubKind }>
  private readonly patterns: Array<{ pattern: RegExp; kind: ScrubKind }>
  private readonly requestHeaderNames: Set<string>
  private readonly responseHeaderNames: Set<string>
  private readonly fakes = new Map<string, string>()
  private readonly counters: Record<Exclude<ScrubKind, 'secret'>, number> = { email: 0, phone: 0, text: 0 }
  private literal: RegExp | null = null

  constructor(
    private readonly config: ScrubConfig = {},
    secrets: Iterable<string> = [],
  ) {
    this.keys = lookup(config.keys)
    this.params = lookup(config.queryParams)
    this.paths = Object.entries(config.paths ?? {}).map(([path, kind]) => ({ segments: path.split('.'), kind }))
    this.patterns = (config.patterns ?? []).map(({ pattern, kind }) => ({
      pattern: new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`),
      kind,
    }))
    this.requestHeaderNames = headerList(DEFAULT_REQUEST_HEADERS, config.keepRequestHeaders, 'request')
    this.responseHeaderNames = headerList(DEFAULT_RESPONSE_HEADERS, config.keepResponseHeaders, 'response')
    for (const secret of secrets) this.learn(secret)
  }

  interaction(interaction: CassetteInteraction): CassetteInteraction {
    const { request, response } = interaction
    return {
      request: {
        method: request.method.toUpperCase(),
        url: this.url(request.url),
        headers: this.headers(request.headers, this.requestHeaderNames),
        body: this.body(request.body, request.headers['content-type'] ?? null),
      },
      response: {
        status: response.status,
        headers: this.headers(response.headers, this.responseHeaderNames),
        body: this.body(response.body, response.headers['content-type'] ?? null),
      },
    }
  }

  url(raw: string): string {
    const url = new URL(raw)
    url.username = ''
    url.password = ''
    url.hash = ''
    const params = [...url.searchParams.entries()].map(([name, value]) => [name, this.param(name, value)] as const)
    url.search = params.length === 0 ? '' : `?${params.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&')}`
    url.pathname = this.text(url.pathname)
    return url.toString()
  }

  headers(headers: Record<string, string>, keep: Set<string>): Record<string, string> {
    const kept: Record<string, string> = {}
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase()
      if (keep.has(lower) && !FORBIDDEN_HEADERS.has(lower)) kept[lower] = this.text(value)
    }
    return kept
  }

  body(body: CassetteBody | null, contentType: string | null): CassetteBody | null {
    if (body === null) return null
    if ('json' in body) return { json: this.json(body.json, []) }
    if ('base64' in body) {
      if (this.config.keepBinaryBodies) return body
      return this.config.replaceBinaryBodies ? binaryPlaceholder(contentType) : null
    }
    if (isFormContentType(contentType)) {
      const params = new URLSearchParams(body.text)
      const scrubbed = new URLSearchParams([...params.entries()].map(([name, value]): [string, string] => [name, this.param(name, value)]))
      return { text: scrubbed.toString() }
    }
    return { text: this.text(body.text) }
  }

  /** Every string in a JSON value, with key, path and pattern rules. */
  json(value: unknown, path: string[], forced?: ScrubKind): unknown {
    if (Array.isArray(value)) return value.map((item) => this.json(item, path, forced))
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => {
          const itemPath = [...path, key]
          return [key, this.json(item, itemPath, forced ?? this.keyKind(key) ?? this.pathKind(itemPath))]
        }),
      )
    }
    if (typeof value === 'string') return forced ? this.fake(forced, value) : this.text(value)
    if (typeof value === 'number' && forced) return 0
    return value
  }

  text(value: string): string {
    let text = this.literal ? value.replace(this.literal, SCRUBBED) : value
    for (const { pattern, kind } of this.patterns) text = text.replace(pattern, (match) => this.fake(kind, match))
    text = text.replace(BEARER_PATTERN, (_, word: string, token: string) => `${word} ${this.fake('secret', token)}`)
    text = text.replace(BASIC_PATTERN, (match, word: string, token: string) =>
      isBasicCredential(token) ? `${word} ${this.fake('secret', token)}` : match,
    )
    text = text.replace(JWT_PATTERN, (match) => this.fake('secret', match))
    text = text.replace(PARAM_PATTERN, (match, lead: string, name: string, raw: string) => {
      const kind = this.paramKind(name)
      if (!kind || raw === '') return match
      const encoded = raw.includes('%') ? encodeURIComponent(this.fake(kind, safeDecode(raw))) : this.fake(kind, raw)
      return `${lead}${name}=${encoded}`
    })
    text = text.replace(EMAIL_PATTERN, (match, domain: string) => (isReservedEmailDomain(domain) ? match : this.fake('email', match)))
    text = text.replace(PHONE_PATTERN, (match) => this.fake('phone', match))
    return text
  }

  private param(name: string, value: string): string {
    const kind = this.paramKind(name)
    return kind && value !== '' ? this.fake(kind, value) : this.text(value)
  }

  private keyKind(key: string): ScrubKind | undefined {
    const name = normalizeName(key)
    return SECRET_NAMES.has(name) ? 'secret' : this.keys.get(name)
  }

  private paramKind(name: string): ScrubKind | undefined {
    const normalized = normalizeName(name)
    return SECRET_PARAM_NAMES.has(normalized) ? 'secret' : this.params.get(normalized)
  }

  private pathKind(path: string[]): ScrubKind | undefined {
    return this.paths.find(
      ({ segments }) => segments.length === path.length && segments.every((segment, index) => segment === '*' || segment === path[index]),
    )?.kind
  }

  private fake(kind: ScrubKind, value: string): string {
    if (isPlaceholder(value)) return value
    if (kind === 'secret') {
      this.learn(value)
      return SCRUBBED
    }
    const key = `${kind}\u0000${value}`
    let fake = this.fakes.get(key)
    if (fake === undefined) {
      const n = ++this.counters[kind]
      fake = kind === 'email' ? `person-${n}@example.com` : kind === 'phone' ? `+000${String(n).padStart(8, '0')}` : `scrubbed-${n}`
      this.fakes.set(key, fake)
    }
    return fake
  }

  private learn(secret: string): void {
    if (secret.length < MIN_LITERAL_SECRET_LENGTH || isPlaceholder(secret) || this.secrets.has(secret)) return
    this.secrets.add(secret)
    const variants = new Set<string>()
    for (const known of this.secrets) {
      variants.add(known)
      variants.add(encodeURIComponent(known))
      variants.add(new URLSearchParams({ v: known }).toString().slice(2))
    }
    // Longest first, so a secret that contains another is replaced whole.
    this.literal = new RegExp([...variants].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|'), 'g')
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '))
  } catch {
    return value
  }
}

/**
 * Scrubs a whole recording in two passes: the first only learns secrets (a token first seen in a later
 * response), the second replaces them everywhere, with placeholders numbered from the start.
 */
export function scrubInteractions(
  interactions: CassetteInteraction[],
  config: ScrubConfig = {},
  secrets: Iterable<string> = [],
): CassetteInteraction[] {
  const learner = new Scrubber(config, secrets)
  interactions.forEach((interaction) => learner.interaction(interaction))
  const scrubber = new Scrubber(config, learner.secrets)
  return interactions.map((interaction) => scrubber.interaction(interaction))
}
