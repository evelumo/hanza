import { CursorExpiredError, errorFromResponse, isConnectorError, PermanentError, TransientError } from '@hanza/connector-sdk'
import { z } from 'zod'
import type { MedusaContext } from './settings'

/** What the client needs from a capability's context. */
export type ClientContext = Pick<MedusaContext, 'config' | 'credentials' | 'fetch'>

/**
 * Query parameters, in the order they are sent. A list value is sent once per item under `name[]` (`arrayParam`); an
 * operator filter is written out by the caller (`created_at[$gte]`); `undefined` is left out.
 */
export type QueryValue = string | number | readonly string[] | undefined
export type Query = ReadonlyArray<readonly [string, QueryValue]>

export interface ApiRequest<T extends z.ZodType> {
  /** Default GET. */
  method?: 'GET' | 'POST'
  /** Below `/admin/`, e.g. `orders` or `hanza/status`. */
  path: string
  query?: Query
  /** Sent as JSON. */
  body?: unknown
  schema: T
  /** Names the response in an error message, e.g. `orders`. */
  what: string
}

/**
 * Says who is asking, the same on every request: firewalls in front of stores often block the `node` that `fetch`
 * sends by itself. No version in it, which would have to be kept in step by hand.
 */
export const USER_AGENT = 'Hanza-Medusa-Connector (+https://github.com/evelumo/hanza)'
/**
 * More than any answer the connector asks for should weigh (a page of 100 whole orders is a few hundred kilobytes). The
 * store is a server a member named: an endless answer must not fill the memory of a worker every organization shares.
 */
export const MAX_RESPONSE_BYTES = 20 * 1024 * 1024
const MAX_ERROR_BYTES = 64 * 1024
const MAX_PATHS_IN_MESSAGE = 10

/** The plugin's routes; a 404 on any of them means the plugin is not there. */
const PLUGIN_PATH = /^hanza\//
export const PLUGIN_NAME = 'medusa-plugin-hanza'
export const PLUGIN_MISSING_MESSAGE =
  `${PLUGIN_NAME} is not installed on this store (Medusa answered 404 to /admin/hanza/status): ` +
  `install it, add { resolve: "${PLUGIN_NAME}" } to the plugins in medusa-config.ts, run npx medusa db:migrate and restart Medusa`
export const LOCATION_NOT_SET_MESSAGE =
  'No stock location is chosen for Hanza in Medusa: pick one on the Hanza page of Medusa\'s admin, then Hanza pushes stock again'

/**
 * How Medusa reads a list in a query: `id[]=a&id[]=b` (its query parser is `qs`). Only here, so the spelling can be
 * changed in one place if a store reads it otherwise. To verify in the sandbox (AGENTS.md).
 */
export function arrayParam(name: string): string {
  return `${name}[]`
}

/**
 * `<storeUrl>/admin/<path>`, for a backend at the root of its host or below a path. Built from the parsed address,
 * never by adding to its text: a `?` or `#` at its end would turn the API path into a query, and the request, with the
 * key, would go elsewhere.
 */
export function apiUrl(storeUrl: string, path: string, query: Query = []): URL {
  if (!URL.canParse(storeUrl)) throw new PermanentError('The Medusa address of the Connection is not a valid address')
  const url = new URL(storeUrl)
  if (url.protocol !== 'https:') throw new PermanentError('The Medusa address of the Connection must start with https://')
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/admin/${path.replace(/^\/+/, '')}`
  for (const [name, value] of query) {
    if (value === undefined) continue
    if (typeof value === 'object') {
      for (const item of value) url.searchParams.append(arrayParam(name), item)
    } else {
      url.searchParams.append(name, String(value))
    }
  }
  return url
}

/** Medusa reads a secret API key from HTTP Basic, raw (`Basic sk_…`) or base64 of `sk_…:`; the raw form is sent. */
export function authorization(credentials: ClientContext['credentials']): string {
  return `Basic ${credentials.apiKey}`
}

async function send(ctx: ClientContext, request: Pick<ApiRequest<z.ZodType>, 'method' | 'path' | 'query' | 'body'>): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': USER_AGENT, authorization: authorization(ctx.credentials) }
  if (request.body !== undefined) headers['content-type'] = 'application/json'
  const url = apiUrl(ctx.config.storeUrl, request.path, request.query)
  try {
    return await ctx.fetch(url, {
      method: request.method ?? 'GET',
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      // A followed redirect turns a POST into a GET and sends the key to another host. Not following makes the
      // redirect the answer, which is not ok.
      redirect: 'manual',
    })
  } catch (error) {
    // The core's rate limiter rejects with a RateLimitedError before sending.
    if (isConnectorError(error)) throw error
    throw new TransientError('The Medusa store could not be reached', { cause: error })
  }
}

function declaredLength(headers: Headers): number | null {
  const value = headers.get('content-length')
  return value !== null && /^\d+$/.test(value.trim()) ? Number(value) : null
}

/** The body as text; null once it passes `limit` bytes, declared or sent (the rest is then left unread). */
async function readText(response: Response, limit: number): Promise<string | null> {
  const declared = declaredLength(response.headers)
  if (declared !== null && declared > limit) {
    await response.body?.cancel().catch(() => {})
    return null
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return text + decoder.decode()
      size += value.byteLength
      if (size > limit) {
        await reader.cancel().catch(() => {})
        return null
      }
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

/** Field paths and issue codes of a parse failure: a value could be Buyer data. */
export function describeIssues(error: z.ZodError): string {
  const paths = [...new Set(error.issues.map((issue) => `${issue.path.join('.') || '(root)'} (${issue.code})`))]
  const more = paths.length > MAX_PATHS_IN_MESSAGE ? ` and ${paths.length - MAX_PATHS_IN_MESSAGE} more` : ''
  return `${paths.slice(0, MAX_PATHS_IN_MESSAGE).join(', ')}${more}`
}

async function parse<T extends z.ZodType>(response: Response, request: ApiRequest<T>): Promise<z.output<T>> {
  let text: string | null
  try {
    text = await readText(response, MAX_RESPONSE_BYTES)
  } catch (error) {
    if (isConnectorError(error)) throw error
    throw new TransientError(`Medusa's ${request.what} response broke off`, { cause: error })
  }
  if (text === null) throw new PermanentError(`Unexpected ${request.what} response from Medusa: larger than ${MAX_RESPONSE_BYTES / 1024 / 1024} MB`)
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    // A firewall or a maintenance page answered instead of Medusa.
    throw new PermanentError(`Unexpected ${request.what} response from Medusa: not JSON`)
  }
  const parsed = request.schema.safeParse(json)
  if (!parsed.success) throw new PermanentError(`Unexpected ${request.what} response from Medusa: ${describeIssues(parsed.error)}`)
  return parsed.data
}

const errorBodySchema = z.object({ code: z.string().optional(), type: z.string().optional() })

/** The `code` of a JSON error body (the plugin's `journal_expired`, `stock_location_not_set`); null when there is none. */
async function errorCode(response: Response): Promise<string | null> {
  try {
    const text = await readText(response.clone(), MAX_ERROR_BYTES)
    const body = errorBodySchema.safeParse(text === null ? null : JSON.parse(text))
    return body.success ? (body.data.code ?? null) : null
  } catch {
    return null
  }
}

/** The error a failed answer stands for. Never includes the body: it may echo data. */
export async function failure(request: Pick<ApiRequest<z.ZodType>, 'path'>, response: Response): Promise<Error> {
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {})
    return new PermanentError(`The Medusa address redirects elsewhere (${response.status}): use the address it redirects to`)
  }
  const isPluginRoute = PLUGIN_PATH.test(request.path)
  if (isPluginRoute && response.status === 404) {
    await response.body?.cancel().catch(() => {})
    return new PermanentError(PLUGIN_MISSING_MESSAGE)
  }
  if (isPluginRoute && (response.status === 410 || response.status === 409)) {
    const code = await errorCode(response)
    if (response.status === 410 && code === 'journal_expired') {
      await response.body?.cancel().catch(() => {})
      return new CursorExpiredError(`410: ${PLUGIN_NAME} no longer keeps the journal position of the Order feed`)
    }
    if (response.status === 409 && code === 'stock_location_not_set') {
      await response.body?.cancel().catch(() => {})
      return new PermanentError(LOCATION_NOT_SET_MESSAGE)
    }
  }
  return errorFromResponse(response)
}

/** One request to Medusa's Admin API. Rejects with a `ConnectorError` for anything but a 2xx answer of the expected shape. */
export async function request<T extends z.ZodType>(ctx: ClientContext, options: ApiRequest<T>): Promise<z.output<T>> {
  const response = await send(ctx, options)
  if (!response.ok) throw await failure(options, response)
  return parse(response, options)
}
