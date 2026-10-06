import { ZodError } from 'zod'

export type ConnectorErrorKind = 'auth_expired' | 'rate_limited' | 'transient' | 'permanent'

const KINDS: readonly string[] = ['auth_expired', 'rate_limited', 'transient', 'permanent']
const MAX_MESSAGE_LENGTH = 1000
const DEFAULT_RETRY_AFTER_MS = 60_000

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

/**
 * `orders.pull` only: the Channel no longer has the position the cursor points at (e.g. a journal kept 60 days and
 * Hanza was stopped longer). The core resets the Order feed to cursor null, which starts again with the Orders open
 * now, and records the restart. A `PermanentError` on purpose: thrown anywhere else, for a null cursor, or twice in
 * one run, it stops the run like any permanent failure.
 */
export class CursorExpiredError extends PermanentError {
  readonly cursorExpired = true

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CursorExpiredError'
  }
}

// Duck-typed for the same reason as `connectorErrorKind`.
export function isCursorExpiredError(error: unknown): boolean {
  if (error instanceof CursorExpiredError) return true
  if (typeof error !== 'object' || error === null) return false
  const { name, kind, cursorExpired } = error as { name?: unknown; kind?: unknown; cursorExpired?: unknown }
  return name === 'CursorExpiredError' && kind === 'permanent' && cursorExpired === true
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

function parseRetryAfter(header: string | null): number {
  if (header === null) return DEFAULT_RETRY_AFTER_MS
  const value = header.trim()
  if (/^\d+$/.test(value)) return Number(value) * 1000
  // Date.parse is lenient ("7.5" or "-1" parse as dates), so check the IMF-fixdate shape first.
  if (!IMF_FIXDATE.test(value)) return DEFAULT_RETRY_AFTER_MS
  const date = Date.parse(value)
  if (Number.isNaN(date)) return DEFAULT_RETRY_AFTER_MS
  return Math.max(0, date - Date.now())
}

/** Never includes the response body: it may carry tokens or personal data. */
export async function errorFromResponse(response: Response): Promise<ConnectorError> {
  await response.body?.cancel().catch(() => {})
  const message = `${response.status} ${response.statusText}`.trim()
  const { status } = response
  if (status === 401 || status === 403) return new AuthExpiredError(message)
  if (status === 429) {
    return new RateLimitedError(message, { retryAfterMs: parseRetryAfter(response.headers.get('Retry-After')) })
  }
  if (status === 408 || status >= 500) return new TransientError(message)
  return new PermanentError(message)
}
