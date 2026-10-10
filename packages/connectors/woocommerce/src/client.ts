import { errorFromResponse, isConnectorError, PermanentError, TransientError } from '@hanza/connector-sdk'
import type { z } from 'zod'
import type { WooCommerceContext } from './settings'

/** What the client needs from a capability's context. */
export type ClientContext = Pick<WooCommerceContext, 'config' | 'credentials' | 'fetch'>

export type QueryValue = string | number | boolean | readonly (string | number)[] | undefined
export type Query = Record<string, QueryValue>

export interface ApiRequest<T extends z.ZodType> {
  /** Default GET. */
  method?: 'GET' | 'POST' | 'PUT'
  /** Below `wc/v3/`, e.g. `orders` or `products/12/variations/batch`. */
  path: string
  /** A list value is sent comma-separated (`status=pending,on-hold`); `undefined` is left out. */
  query?: Query
  /** Sent as JSON. */
  body?: unknown
  schema: T
  /** Names the response in an error message, e.g. `orders`. */
  what: string
}

export interface ApiResponse<T> {
  data: T
  /** The shop's clock when it answered (the `Date` header), in milliseconds since the epoch; null when it sent none. */
  shopTimeMs: number | null
  /** Whether the list has a page after this one. */
  hasNextPage: boolean
  /** `X-WP-TotalPages` of a list; null on other responses, and where a proxy dropped it. */
  totalPages: number | null
}

const API_ROOT = 'wp-json/wc/v3'
const MAX_PATHS_IN_MESSAGE = 10
/**
 * More than any answer of the API should weigh (a page of 100 whole orders is around a megabyte). The shop is a
 * server a member named: an endless answer must not fill the memory of a worker every organization shares.
 */
export const MAX_RESPONSE_BYTES = 20 * 1024 * 1024
// WooCommerce's errors are a code, a sentence and a status.
const MAX_ERROR_BYTES = 64 * 1024

/**
 * `<storeUrl>/wp-json/wc/v3/<path>`, for a shop at the root of its host or in a subdirectory. Built from the parsed
 * address, never by adding to its text: a `?` or `#` at its end would turn the API path into a query or a fragment,
 * and the request, with the key, would go to the shop's front page. `configSchema` refuses such an address; this
 * holds for one stored before it did.
 */
export function apiUrl(storeUrl: string, path: string, query: Query = {}): URL {
  if (!URL.canParse(storeUrl)) throw new PermanentError('The shop address of the Connection is not a valid address')
  const url = new URL(storeUrl)
  // The key travels in a header, and WooCommerce accepts it only over TLS.
  if (url.protocol !== 'https:') throw new PermanentError('The shop address of the Connection must start with https://')
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  // The setter escapes a `?` or `#` in the path instead of starting a query or a fragment with it.
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${API_ROOT}/${path.replace(/^\/+/, '')}`
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined) continue
    url.searchParams.set(name, typeof value === 'object' ? value.join(',') : String(value))
  }
  return url
}

/** HTTP Basic with the consumer key as the user name. Encoded as UTF-8, so no pasted character can make `btoa` throw. */
export function authorization(credentials: ClientContext['credentials']): string {
  let binary = ''
  // Byte by byte: spreading the bytes into one `String.fromCharCode` call throws a RangeError for a long value.
  for (const byte of new TextEncoder().encode(`${credentials.consumerKey}:${credentials.consumerSecret}`)) binary += String.fromCharCode(byte)
  return `Basic ${btoa(binary)}`
}

async function send(ctx: ClientContext, request: Pick<ApiRequest<z.ZodType>, 'method' | 'path' | 'query' | 'body'>): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json', authorization: authorization(ctx.credentials) }
  if (request.body !== undefined) headers['content-type'] = 'application/json'
  const url = apiUrl(ctx.config.storeUrl, request.path, request.query)
  try {
    return await ctx.fetch(url, {
      method: request.method ?? 'GET',
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      // A followed redirect turns a PUT or POST into a GET and drops the key on another host: the write would
      // be lost behind a 200. Not following makes the redirect the answer, which is not ok.
      redirect: 'manual',
    })
  } catch (error) {
    // The core's rate limiter rejects with a RateLimitedError before sending.
    if (isConnectorError(error)) throw error
    throw new TransientError('The shop could not be reached', { cause: error })
  }
}

function count(headers: Headers, name: string): number | null {
  const value = headers.get(name)
  return value !== null && /^\d+$/.test(value.trim()) ? Number(value) : null
}

/** The `Date` header as milliseconds since the epoch; null when it is missing or not a date. */
export function shopTimeFrom(headers: Headers): number | null {
  const value = headers.get('date')
  if (value === null) return null
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : time
}

/**
 * `rel="next"` in the `Link` header (every WordPress response has a `Link` header, so only that relation counts);
 * where a proxy dropped it, `X-WP-TotalPages` against the `page` that was asked for.
 */
export function hasNextPageFrom(headers: Headers, page: number): boolean {
  const link = headers.get('link')
  if (link !== null && /;\s*rel="?next"?/i.test(link)) return true
  const totalPages = count(headers, 'x-wp-totalpages')
  return link === null && totalPages !== null && page < totalPages
}

/** The body as text; null once it passes `limit` bytes, declared or sent (the rest is then left unread). */
async function readText(response: Response, limit: number): Promise<string | null> {
  const declared = count(response.headers, 'content-length')
  if (declared !== null && declared > limit) {
    await response.body?.cancel().catch(() => {})
    return null
  }
  if (response.body === null) return ''
  // An answer sent in chunks declares no length, so the bytes are counted as they come.
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

async function parse<T extends z.ZodType>(response: Response, request: ApiRequest<T>): Promise<ApiResponse<z.output<T>>> {
  let text: string | null
  try {
    text = await readText(response, MAX_RESPONSE_BYTES)
  } catch (error) {
    // The connection broke, or the core's timeout ended the request, after the headers had arrived.
    if (isConnectorError(error)) throw error
    throw new TransientError(`The shop's ${request.what} response broke off`, { cause: error })
  }
  if (text === null) throw new PermanentError(`Unexpected ${request.what} response from the shop: larger than ${MAX_RESPONSE_BYTES / 1024 / 1024} MB`)
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    // A firewall or a maintenance page answered instead of WooCommerce.
    throw new PermanentError(`Unexpected ${request.what} response from the shop: not JSON`)
  }
  const parsed = request.schema.safeParse(json)
  if (!parsed.success) {
    // Paths and issue codes only: a value could be Buyer data.
    const paths = [...new Set(parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'} (${issue.code})`))]
    const shown = paths.slice(0, MAX_PATHS_IN_MESSAGE).join(', ')
    const more = paths.length > MAX_PATHS_IN_MESSAGE ? ` and ${paths.length - MAX_PATHS_IN_MESSAGE} more` : ''
    throw new PermanentError(`Unexpected ${request.what} response from the shop: ${shown}${more}`)
  }
  const page = Number(request.query?.page ?? 1)
  return {
    data: parsed.data,
    shopTimeMs: shopTimeFrom(response.headers),
    hasNextPage: hasNextPageFrom(response.headers, Number.isInteger(page) ? page : 1),
    totalPages: count(response.headers, 'x-wp-totalpages'),
  }
}

async function failure(response: Response): Promise<Error> {
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {})
    // Typically http → https, or a missing or extra "www": the address in the Connection is not the shop's own.
    return new PermanentError(`The shop address redirects elsewhere (${response.status}): use the address it redirects to`)
  }
  return errorFromResponse(response)
}

/** One request to the shop's `wc/v3` API. Rejects with a `ConnectorError` for anything but a 2xx answer of the expected shape. */
export async function request<T extends z.ZodType>(ctx: ClientContext, options: ApiRequest<T>): Promise<ApiResponse<z.output<T>>> {
  const response = await send(ctx, options)
  if (!response.ok) throw await failure(response)
  return parse(response, options)
}

// WooCommerce's own "no such product / variation / order" (`woocommerce_rest_shop_order_invalid_id`, ...). A 404 with
// any other code (`rest_no_route`: wrong address, plain permalinks, WooCommerce switched off) is a failure.
const MISSING_RESOURCE_CODE = /^woocommerce_rest_.*invalid_(product_)?id$/

/** Reads the body of a 404 to tell; the error made of the response afterwards needs its status only. */
async function isMissingResource(response: Response): Promise<boolean> {
  if (response.status !== 404) return false
  try {
    const text = await readText(response, MAX_ERROR_BYTES)
    const body: unknown = text === null ? null : JSON.parse(text)
    const code = typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined
    return typeof code === 'string' && MISSING_RESOURCE_CODE.test(code)
  } catch {
    return false
  }
}

/** Like `request`, but resolves with null when WooCommerce says the product, variation or order does not exist (any more). */
export async function requestIfFound<T extends z.ZodType>(ctx: ClientContext, options: ApiRequest<T>): Promise<ApiResponse<z.output<T>> | null> {
  const response = await send(ctx, options)
  if (response.ok) return parse(response, options)
  if (await isMissingResource(response)) return null
  throw await failure(response)
}

/**
 * Like `request`, but resolves with null on a 403: the key's user has no right to this one resource. Only for
 * something a capability can do without (the shop currency); anywhere else a 403 has to fail the call.
 */
export async function requestIfAllowed<T extends z.ZodType>(ctx: ClientContext, options: ApiRequest<T>): Promise<ApiResponse<z.output<T>> | null> {
  const response = await send(ctx, options)
  if (response.ok) return parse(response, options)
  if (response.status === 403) {
    await response.body?.cancel().catch(() => {})
    return null
  }
  throw await failure(response)
}
