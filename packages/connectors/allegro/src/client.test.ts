import { classifyConnectorError, ConnectorError, PermanentError, RateLimitedError, TransientError } from '@hanza/connector-sdk'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { apiUrl, concurrently, errorCodeOf, parse, PUBLIC_JSON, request, send, type AllegroContext } from './client'

const ACCESS_TOKEN = 'access-token-test-0001'
const REFRESH_TOKEN = 'refresh-token-test-0002'
const CLIENT_SECRET = 'client-secret-test-0003'

interface Recorded {
  url: string
  method: string
  headers: Headers
  body: string | null
}

function stubFetch(answer: (call: Recorded) => Response | Promise<Response>) {
  const calls: Recorded[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body === undefined || init.body === null ? null : String(init.body),
    }
    calls.push(call)
    return answer(call)
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

function context(fetch: typeof globalThis.fetch, environment: 'production' | 'sandbox' = 'production'): AllegroContext {
  return {
    app: { clientId: 'client-id-test', clientSecret: CLIENT_SECRET, environment, appName: 'Hanza Test Shop' },
    config: {},
    credentials: { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN, accessTokenExpiresAt: '2030-01-01T00:00:00.000Z' },
    fetch,
    log: () => {},
  }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': PUBLIC_JSON, ...headers } })

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

function expectNoSecret(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, CLIENT_SECRET]) expect(message).not.toContain(secret)
}

describe('apiUrl', () => {
  it('builds the URL on the environment API host', () => {
    expect(apiUrl({ environment: 'production' }, '/me')).toBe('https://api.allegro.pl/me')
    expect(apiUrl({ environment: 'sandbox' }, '/me')).toBe('https://api.allegro.pl.allegrosandbox.pl/me')
  })

  it('repeats a parameter once per value, in order, and leaves undefined ones out', () => {
    const url = apiUrl({ environment: 'production' }, '/sale/offers', {
      limit: '1000',
      'publication.status': ['ACTIVE', 'ACTIVATING', 'ENDED'],
      offset: undefined,
    })
    expect(url).toBe('https://api.allegro.pl/sale/offers?limit=1000&publication.status=ACTIVE&publication.status=ACTIVATING&publication.status=ENDED')
    expect(new URL(url).searchParams.getAll('publication.status')).toEqual(['ACTIVE', 'ACTIVATING', 'ENDED'])
  })

  it('encodes parameter values', () => {
    const url = apiUrl({ environment: 'production' }, '/order/checkout-forms', { 'lineItems.boughtAt.lte': '2026-10-10T12:00:00+02:00' })
    expect(new URL(url).searchParams.get('lineItems.boughtAt.lte')).toBe('2026-10-10T12:00:00+02:00')
  })

  it('refuses a path without a leading slash', () => {
    expect(() => apiUrl({ environment: 'production' }, 'me')).toThrow(PermanentError)
  })
})

describe('request', () => {
  it('sends Accept, User-Agent and the bearer token on a GET', async () => {
    const { fetch, calls } = stubFetch(() => json({}))
    await request(context(fetch), '/me')
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call?.url).toBe('https://api.allegro.pl/me')
    expect(call?.method).toBe('GET')
    expect(call?.headers.get('accept')).toBe(PUBLIC_JSON)
    expect(call?.headers.get('user-agent')).toBe('Hanza Test Shop/0.1.0 (+https://github.com/evelumo/hanza)')
    expect(call?.headers.get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(call?.headers.has('content-type')).toBe(false)
    expect(call?.body).toBeNull()
  })

  it('sends a JSON body with the public content type', async () => {
    const { fetch, calls } = stubFetch(() => new Response(null, { status: 204 }))
    await request(context(fetch, 'sandbox'), '/sale/product-offers/123', { method: 'PATCH', json: { stock: { available: 0 } } })
    const [call] = calls
    expect(call?.url).toBe('https://api.allegro.pl.allegrosandbox.pl/sale/product-offers/123')
    expect(call?.method).toBe('PATCH')
    expect(call?.headers.get('content-type')).toBe(PUBLIC_JSON)
    expect(call?.headers.get('accept')).toBe(PUBLIC_JSON)
    expect(call?.headers.get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(JSON.parse(call?.body ?? '')).toEqual({ stock: { available: 0 } })
  })

  it('passes the query and lets a header be overridden without duplicating it', async () => {
    const { fetch, calls } = stubFetch(() => json({}))
    await request(context(fetch), '/order/events', { query: { from: 'e-1', limit: '100' }, headers: { Accept: 'application/json' } })
    expect(calls[0]?.url).toBe('https://api.allegro.pl/order/events?from=e-1&limit=100')
    expect(calls[0]?.headers.get('accept')).toBe('application/json')
  })

  it('returns a failed response instead of throwing', async () => {
    const { fetch } = stubFetch(() => json({ errors: [{ code: 'NOT_FOUND' }] }, 404))
    const response = await request(context(fetch), '/sale/product-offers/1')
    expect(response.status).toBe(404)
  })

  it('lets a ConnectorError from fetch through unchanged', async () => {
    const limited = new RateLimitedError('Rate limit of the connector reached', { retryAfterMs: 1500 })
    const { fetch } = stubFetch(() => {
      throw limited
    })
    expect(await failure(request(context(fetch), '/me'))).toBe(limited)
  })

  it('turns a network failure or a timeout into a TransientError with the cause', async () => {
    for (const cause of [new TypeError('fetch failed'), new DOMException('The operation timed out.', 'TimeoutError')]) {
      const { fetch } = stubFetch(() => {
        throw cause
      })
      const error = await failure(request(context(fetch), '/me'))
      expect(error).toBeInstanceOf(TransientError)
      expect((error as TransientError).cause).toBe(cause)
      expectNoSecret(error)
    }
  })
})

describe('send', () => {
  it('returns a 2xx response', async () => {
    const { fetch } = stubFetch(() => json({ id: '1' }))
    expect((await send(context(fetch), '/me')).status).toBe(200)
  })

  it.each([
    [401, 'auth_expired'],
    [403, 'permanent'],
    [404, 'permanent'],
    [422, 'permanent'],
    [429, 'rate_limited'],
    [500, 'transient'],
    [503, 'transient'],
  ] as const)('maps %i to %s, without the body or a token in the message', async (status, kind) => {
    const body = status === 401 ? { error: 'invalid_token', error_description: `token ${ACCESS_TOKEN} expired` } : { errors: [{ code: 'X', message: `bad ${ACCESS_TOKEN}`, userMessage: 'Jan Kowalski' }] }
    const { fetch } = stubFetch(() => json(body, status))
    const error = await failure(send(context(fetch), '/me'))
    expect(error).toBeInstanceOf(ConnectorError)
    expect(classifyConnectorError(error).kind).toBe(kind)
    expectNoSecret(error)
    expect((error as Error).message).not.toContain('Kowalski')
  })

  it('reads Retry-After on a 429, and waits 60 s without it', async () => {
    const withHeader = await failure(send(context(stubFetch(() => json({}, 429, { 'Retry-After': '30' })).fetch), '/me'))
    expect(withHeader).toBeInstanceOf(RateLimitedError)
    expect((withHeader as RateLimitedError).retryAfterMs).toBe(30_000)
    const without = await failure(send(context(stubFetch(() => json({}, 429)).fetch), '/me'))
    expect(without).toBeInstanceOf(RateLimitedError)
    expect((without as RateLimitedError).retryAfterMs).toBe(60_000)
  })
})

describe('parse', () => {
  const schema = z.object({ id: z.string(), lines: z.array(z.object({ quantity: z.number() })), meta: z.record(z.string(), z.number()) })

  it('returns the parsed body', async () => {
    expect(await parse(json({ id: 'a', lines: [{ quantity: 1 }], meta: {} }), schema, 'test')).toEqual({ id: 'a', lines: [{ quantity: 1 }], meta: {} })
  })

  it('names the issue paths and never a value', async () => {
    const response = json({ id: 42, lines: [{ quantity: 'jan.kowalski@example.com' }], meta: { 'jan.kowalski@example.com': 'secret-value' } })
    const error = await failure(parse(response, schema, 'offers'))
    expect(error).toBeInstanceOf(PermanentError)
    const { message } = error as PermanentError
    expect(message).toMatch(/^Unexpected offers response: /)
    expect(message).toContain('id')
    expect(message).toContain('lines.0.quantity')
    expect(message).toContain('meta.?')
    expect(message).not.toContain('42')
    expect(message).not.toContain('kowalski')
    expect(message).not.toContain('secret-value')
  })

  it('treats a body that is not JSON as a shape failure', async () => {
    const error = await failure(parse(new Response('<html>', { status: 200 }), schema, 'account'))
    expect(error).toBeInstanceOf(PermanentError)
    expect((error as Error).message).toBe('Unexpected account response: (root)')
  })

  it('treats a body that cannot be read as transient, and lets a connector error through', async () => {
    const timedOut = await failure(parse(failingBody(new DOMException('The operation timed out', 'TimeoutError')), schema, 'offers'))
    expect(timedOut).toBeInstanceOf(TransientError)
    expect((timedOut as Error).cause).toMatchObject({ name: 'TimeoutError' })
    const limited = new RateLimitedError('limited', { retryAfterMs: 1000 })
    expect(await failure(parse(failingBody(limited), schema, 'offers'))).toBe(limited)
  })
})

describe('errorCodeOf', () => {
  it('returns the first error code', async () => {
    expect(await errorCodeOf(json({ errors: [{ code: 'OFFER_NOT_ACTIVE', message: 'x' }, { code: 'OTHER' }] }, 422))).toBe('OFFER_NOT_ACTIVE')
    expect(await errorCodeOf(json({ errors: [{ code: 'a.b:c-d_1', message: null, metadata: { productId: '1' } }] }, 422))).toBe('a.b:c-d_1')
  })

  it('returns null for a code that is not a plain code', async () => {
    expect(await errorCodeOf(json({ errors: [{ code: 'Offer of Jan Kowalski' }] }, 422))).toBeNull()
    expect(await errorCodeOf(json({ errors: [{ code: 'A'.repeat(101) }] }, 422))).toBeNull()
    expect(await errorCodeOf(json({ errors: [{ code: '' }] }, 422))).toBeNull()
  })

  it('returns null for any other body, without throwing', async () => {
    expect(await errorCodeOf(json({ errors: [] }, 422))).toBeNull()
    expect(await errorCodeOf(json({ error: 'invalid_token' }, 401))).toBeNull()
    expect(await errorCodeOf(new Response('not json', { status: 500 }))).toBeNull()
    expect(await errorCodeOf(new Response(null, { status: 404 }))).toBeNull()
  })

  it('fails transiently when the body cannot be read', async () => {
    const error = await failure(errorCodeOf(failingBody(new DOMException('The operation timed out', 'TimeoutError'), 422)))
    expect(error).toBeInstanceOf(TransientError)
  })
})

/** A response whose body stream fails with `error` once read. */
function failingBody(error: unknown, status = 200): Response {
  const stream = new ReadableStream({
    pull(controller) {
      controller.error(error)
    },
  })
  return new Response(stream, { status, headers: { 'content-type': PUBLIC_JSON } })
}

describe('concurrently', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('keeps the input order and never has more than the limit in flight', async () => {
    let inFlight = 0
    let peak = 0
    const results = await concurrently([5, 1, 4, 2, 3, 0, 6], 3, async (item, index) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      for (let i = 0; i < item; i++) await tick()
      inFlight--
      return `${index}:${item}`
    })
    expect(results).toEqual(['0:5', '1:1', '2:4', '3:2', '4:3', '5:0', '6:6'])
    expect(peak).toBe(3)
  })

  it('returns an empty array for no items', async () => {
    expect(await concurrently([], 3, async () => 1)).toEqual([])
  })

  it('rejects with the first error once the in-flight ones settle, and starts no new one', async () => {
    const started: number[] = []
    const settled: number[] = []
    const first = new TransientError('first')
    const promise = concurrently([0, 1, 2, 3, 4], 2, async (item) => {
      started.push(item)
      if (item === 0) {
        await tick()
        throw first
      }
      if (item === 1) {
        for (let i = 0; i < 3; i++) await tick()
        settled.push(item)
        throw new TransientError('second')
      }
      settled.push(item)
      return item
    })
    expect(await failure(promise)).toBe(first)
    expect(settled).toContain(1)
    expect(started).toEqual([0, 1])
  })
})
