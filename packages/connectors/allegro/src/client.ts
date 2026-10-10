import {
  errorFromResponse,
  isConnectorError,
  PermanentError,
  TransientError,
  type AuthContext,
  type CapabilityContext,
  type ConnectorError,
} from '@hanza/connector-sdk'
import type { z } from 'zod'
import { issuePaths } from './api/common'
import { errorsHolderSchema } from './api/errors'
import { environmentHosts, userAgent, type AllegroApp, type AllegroConfig, type AllegroCredentials } from './settings'

export { issuePaths }

export type AllegroContext = CapabilityContext<AllegroConfig, AllegroCredentials, AllegroApp>
export type AllegroAuthContext = AuthContext<AllegroConfig, AllegroApp>

/** Allegro's versioned media type: `Accept` on every API request, `Content-Type` on every JSON body. */
export const PUBLIC_JSON = 'application/vnd.allegro.public.v1+json'

/** Query parameters; an array repeats the parameter once per value, in order; `undefined` leaves it out. */
export type Query = Record<string, string | readonly string[] | undefined>

export interface AllegroRequest {
  method?: string
  query?: Query
  /** Sent as JSON with the public content type. */
  json?: unknown
  /** Override or add headers (case-insensitive). */
  headers?: Record<string, string>
}

const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,100}$/

/** `path` is the API path with its segments already encoded, e.g. `/sale/offers`. */
export function apiUrl(app: Pick<AllegroApp, 'environment'>, path: string, query: Query = {}): string {
  if (!path.startsWith('/')) throw new PermanentError('An Allegro API path must start with "/"')
  const url = new URL(`${environmentHosts(app.environment).api}${path}`)
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined) continue
    for (const item of typeof value === 'string' ? [value] : value) url.searchParams.append(name, item)
  }
  return url.toString()
}

/**
 * `ctx.fetch` that throws only connector errors. A `ConnectorError` passes through unchanged: the core's rate limiter
 * rejects with `RateLimitedError` before sending, and that must keep its class. Anything else (a network `TypeError`,
 * an `AbortError`, a `TimeoutError`) means Allegro could not be reached.
 */
export async function fetchAllegro(ctx: { fetch: typeof fetch }, url: string, init: RequestInit): Promise<Response> {
  try {
    return await ctx.fetch(url, init)
  } catch (error) {
    if (isConnectorError(error)) throw error
    throw new TransientError('Allegro could not be reached', { cause: error })
  }
}

/** One authorised API request. Never throws on an HTTP status: the caller decides what each one means. */
export async function request(ctx: AllegroContext, path: string, init: AllegroRequest = {}): Promise<Response> {
  const headers = new Headers({
    accept: PUBLIC_JSON,
    'user-agent': userAgent(ctx.app),
    authorization: `Bearer ${ctx.credentials.accessToken}`,
  })
  if (init.json !== undefined) headers.set('content-type', PUBLIC_JSON)
  for (const [name, value] of Object.entries(init.headers ?? {})) headers.set(name, value)
  return fetchAllegro(ctx, apiUrl(ctx.app, path, init.query), {
    method: init.method ?? 'GET',
    headers,
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
  })
}

/** `request`, throwing the matching connector error for any status other than 2xx. */
export async function send(ctx: AllegroContext, path: string, init: AllegroRequest = {}): Promise<Response> {
  const response = await request(ctx, path, init)
  if (!response.ok) throw await failureOf(response)
  return response
}

/** The connector error for a failed response; never includes the body. */
export function failureOf(response: Response): Promise<ConnectorError> {
  return errorFromResponse(response)
}

/**
 * The body as JSON, or undefined when it is empty or not JSON (which the caller's schema then refuses, a
 * `PermanentError`). A `ConnectorError` raised while reading passes through; any other read failure (the connection
 * reset, the 30 s timeout firing mid-body) is a `TransientError`, since a retry may well read it whole.
 */
export async function readJson(response: Response, what: string): Promise<unknown> {
  let text: string
  try {
    text = await response.text()
  } catch (error) {
    if (isConnectorError(error)) throw error
    throw new TransientError(`The Allegro ${what} response could not be read`, { cause: error })
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    // Empty or not JSON (a `SyntaxError`): no schema accepts it, so the caller's parse fails permanently.
    return undefined
  }
}

/**
 * Reads the body and parses it with `schema`. A body that does not fit (or is not JSON) is a `PermanentError` naming
 * the paths only: a value could be a token or Buyer data. A body that cannot be read is a `TransientError`.
 */
export async function parse<T extends z.ZodType>(response: Response, schema: T, what: string): Promise<z.output<T>> {
  const parsed = schema.safeParse(await readJson(response, what))
  if (!parsed.success) throw new PermanentError(`Unexpected ${what} response: ${issuePaths(parsed.error)}`)
  return parsed.data
}

/**
 * The first `errors[].code` of an Allegro error body when it is a plain code, else null. Reads the body. A body that
 * is missing or not an error body is null; one that cannot be read throws like `readJson` (a `TransientError`).
 */
export async function errorCodeOf(response: Response): Promise<string | null> {
  const parsed = errorsHolderSchema.safeParse(await readJson(response, 'error'))
  const code = parsed.success ? parsed.data.errors[0]?.code : undefined
  return code !== undefined && ERROR_CODE.test(code) ? code : null
}

/**
 * Runs `run` for every item with at most `limit` in flight; results in input order. On a failure no new item starts,
 * and once the ones in flight settle it rejects with the first error.
 */
export async function concurrently<T, R>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  const width = Math.min(Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1, items.length)
  let next = 0
  let failure: { error: unknown } | null = null
  const lane = async () => {
    while (failure === null && next < items.length) {
      const index = next++
      try {
        results[index] = await run(items[index] as T, index)
      } catch (error) {
        failure ??= { error }
      }
    }
  }
  await Promise.all(Array.from({ length: width }, lane))
  if (failure !== null) throw (failure as { error: unknown }).error
  return results
}
