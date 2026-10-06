import { ZodError } from 'zod'

export type ConnectorErrorKind = 'auth_expired' | 'rate_limited' | 'transient' | 'permanent'

const KINDS: readonly string[] = ['auth_expired', 'rate_limited', 'transient', 'permanent']
const MAX_MESSAGE_LENGTH = 1000
/** The wait assumed for a 429 that does not say how long to wait. */
export const DEFAULT_RETRY_AFTER_MS = 60_000

export class ConnectorError extends Error {
  readonly kind: ConnectorErrorKind

  constructor(kind: ConnectorErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ConnectorError'
    this.kind = kind
  }
}

/** The Channel rejected the credentials; a person has to sign in again. */
export class AuthExpiredError extends ConnectorError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('auth_expired', message, options)
    this.name = 'AuthExpiredError'
  }
}

export class RateLimitedError extends ConnectorError {
  readonly retryAfterMs: number

  constructor(message: string, options: { retryAfterMs: number; cause?: unknown }) {
    super('rate_limited', message, options)
    this.name = 'RateLimitedError'
    this.retryAfterMs = options.retryAfterMs
  }
}

/** Worth retrying: network trouble, timeouts, 5xx. */
export class TransientError extends ConnectorError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('transient', message, options)
    this.name = 'TransientError'
  }
}

/** Retrying cannot help: the request or the connector is wrong. */
export class PermanentError extends ConnectorError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('permanent', message, options)
    this.name = 'PermanentError'
  }
}

function messageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message
  }
  return String(error)
}

function truncate(message: string): string {
  return message.length > MAX_MESSAGE_LENGTH ? message.slice(0, MAX_MESSAGE_LENGTH) : message
}

// Duck-typed as well as instanceof: a second copy of this module (bundler, linked package) would break instanceof.
function connectorErrorKind(error: unknown): ConnectorErrorKind | null {
  if (error instanceof ConnectorError) return error.kind
  if (typeof error !== 'object' || error === null) return null
  const { name, kind } = error as { name?: unknown; kind?: unknown }
  if (typeof name === 'string' && name.endsWith('Error') && typeof kind === 'string' && KINDS.includes(kind)) {
    return kind as ConnectorErrorKind
  }
  return null
}

export function isConnectorError(error: unknown): boolean {
  return connectorErrorKind(error) !== null
}

export function classifyConnectorError(error: unknown): {
  kind: ConnectorErrorKind
  retryAfterMs: number | null
  message: string
} {
  const message = truncate(messageOf(error))

  const kind = connectorErrorKind(error)
  if (kind !== null) {
    let retryAfterMs: number | null = null
    if (kind === 'rate_limited') {
      const value = (error as { retryAfterMs?: unknown }).retryAfterMs
      retryAfterMs = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : DEFAULT_RETRY_AFTER_MS
    }
    return { kind, retryAfterMs, message }
  }
  // The connector returned data that breaks the canonical schemas: a bug, not a hiccup.
  if (error instanceof ZodError) return { kind: 'permanent', retryAfterMs: null, message }
  // TypeError from fetch, AbortError, TimeoutError and everything unknown: retry.
  return { kind: 'transient', retryAfterMs: null, message }
}

const IMF_FIXDATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/
const DELTA_SECONDS = /^\d+(\.\d+)?$/
// A reset header above this many seconds is read as a Unix time, not a delay (a delay of ~1 year never happens).
const EPOCH_SECONDS_THRESHOLD = 31_536_000

function parseDelay(header: string | null, allowDate: boolean, now: number): number | null {
  if (header === null) return null
  const value = header.trim()
  if (DELTA_SECONDS.test(value)) {
    const seconds = Number(value)
    if (seconds > EPOCH_SECONDS_THRESHOLD && !allowDate) return Math.max(0, seconds * 1000 - now)
    return Math.round(seconds * 1000)
  }
  // Date.parse is lenient ("-1" parses as a date), so check the IMF-fixdate shape first.
  if (!allowDate || !IMF_FIXDATE.test(value)) return null
  const date = Date.parse(value)
  return Number.isNaN(date) ? null : Math.max(0, date - now)
}

/**
 * How long a Channel asked us to wait, from `Retry-After` (seconds, decimals allowed, or an HTTP date), else from
 * `RateLimit-Reset` / `X-RateLimit-Reset` (seconds, or a Unix time in seconds). Null when none of them is readable.
 * Tolerant on purpose: many APIs (Allegro among them) do not document their 429 headers.
 */
export function retryAfterFromHeaders(headers: Headers, now = Date.now()): number | null {
  return (
    parseDelay(headers.get('Retry-After'), true, now) ??
    parseDelay(headers.get('RateLimit-Reset'), false, now) ??
    parseDelay(headers.get('X-RateLimit-Reset'), false, now)
  )
}

export interface ErrorFromResponseOptions {
  /**
   * The Channel's own sign that the credentials are no longer accepted, for statuses other than 401
   * (which always is one): for example a token endpoint's `400 invalid_grant`, or a Channel whose 403 means
   * "signed out". May read the body; the error message never includes it.
   */
  isAuthFailure?: (response: Response) => boolean | Promise<boolean>
}

const INVALID_TOKEN = /error\s*=\s*"?invalid_token"?/i

async function isAuthSignal(response: Response, options: ErrorFromResponseOptions): Promise<boolean> {
  if (response.status === 401) return true
  // RFC 6750: a bearer token the server no longer accepts, whatever the status.
  if (INVALID_TOKEN.test(response.headers.get('WWW-Authenticate') ?? '')) return true
  if (!options.isAuthFailure) return false
  try {
    return await options.isAuthFailure(response)
  } catch {
    // An unreadable body is not a sign of anything; the status decides.
    return false
  }
}

/**
 * Maps a failed response to the error class the engine acts on. Only an explicit auth signal (401, a
 * `WWW-Authenticate: Bearer error="invalid_token"`, or `options.isAuthFailure`) asks for a new sign-in; any other
 * 403 means "no right to this resource" and is permanent for this run. Never includes the response body: it may
 * carry tokens or personal data.
 */
export async function errorFromResponse(response: Response, options: ErrorFromResponseOptions = {}): Promise<ConnectorError> {
  const message = `${response.status} ${response.statusText}`.trim()
  const auth = await isAuthSignal(response, options)
  await response.body?.cancel().catch(() => {})
  const { status } = response
  if (auth) return new AuthExpiredError(message)
  if (status === 429) {
    return new RateLimitedError(message, { retryAfterMs: retryAfterFromHeaders(response.headers) ?? DEFAULT_RETRY_AFTER_MS })
  }
  if (status === 408 || status >= 500) return new TransientError(message)
  return new PermanentError(message)
}
