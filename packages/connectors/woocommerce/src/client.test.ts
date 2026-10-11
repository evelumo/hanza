import { AuthExpiredError, PermanentError, RateLimitedError, TransientError } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  apiUrl,
  authorization,
  hasNextPageFrom,
  MAX_RESPONSE_BYTES,
  READ_ONLY_KEY_MESSAGE,
  request,
  requestIfAllowed,
  requestIfFound,
  shopTimeFrom,
  USER_AGENT,
  type ClientContext,
} from './client'

const credentials = { consumerKey: 'ck_test_consumer_key', consumerSecret: 'cs_test_consumer_secret' }
const schema = z.array(z.object({ id: z.number(), billing: z.object({ email: z.string() }).optional() }))

interface Call {
  url: string
  init: RequestInit
}

function context(answer: (call: Call) => Response | Promise<Response>, storeUrl = 'https://shop.example.test') {
  const calls: Call[] = []
  const ctx: ClientContext = {
    config: { storeUrl },
    credentials,
    fetch: async (input, init = {}) => {
      const call = { url: String(input), init }
      calls.push(call)
      return answer(call)
    },
  }
  return { ctx, calls }
}

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=UTF-8' }, ...init })
// The error bodies below are the sandbox's, word for word.
const wooError = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  json({ code, message, data: { status } }, { status, headers: { 'content-type': 'application/json; charset=UTF-8', ...headers } })

describe('apiUrl', () => {
  it.each([
    ['https://shop.example.test', 'orders', 'https://shop.example.test/wp-json/wc/v3/orders'],
    ['https://shop.example.test/', 'orders', 'https://shop.example.test/wp-json/wc/v3/orders'],
    ['https://shop.example.test///', '/orders/39', 'https://shop.example.test/wp-json/wc/v3/orders/39'],
    // A shop in a subdirectory of its host.
    ['https://example.test/sklep', 'products/19/variations/batch', 'https://example.test/sklep/wp-json/wc/v3/products/19/variations/batch'],
    ['https://example.test/sklep/', 'data/currencies/current', 'https://example.test/sklep/wp-json/wc/v3/data/currencies/current'],
    ['https://shop.example.test:8443/a/b/', 'orders', 'https://shop.example.test:8443/a/b/wp-json/wc/v3/orders'],
  ])('%s + %s', (storeUrl, path, expected) => {
    expect(apiUrl(storeUrl, path).toString()).toBe(expected)
  })

  it('sends a list comma-separated, and leaves out what is undefined', () => {
    const url = apiUrl('https://shop.example.test', 'orders', {
      status: ['pending', 'on-hold', 'processing'],
      per_page: 100,
      orderby: 'modified',
      order: 'asc',
      modified_after: '2026-10-10T18:51:38Z',
      dates_are_gmt: undefined,
      include: [39, 40],
      force: false,
    })
    expect(Object.fromEntries(url.searchParams)).toEqual({
      status: 'pending,on-hold,processing',
      per_page: '100',
      orderby: 'modified',
      order: 'asc',
      modified_after: '2026-10-10T18:51:38Z',
      include: '39,40',
      force: 'false',
    })
  })
})

describe('apiUrl and an address that is more than where the shop is', () => {
  // `configSchema` refuses these; one stored before it did must still not send the key anywhere but the API.
  it.each([
    ['https://shop.example.test/?', 'https://shop.example.test/wp-json/wc/v3/orders?per_page=5'],
    ['https://shop.example.test/#', 'https://shop.example.test/wp-json/wc/v3/orders?per_page=5'],
    ['https://shop.example.test?x=1', 'https://shop.example.test/wp-json/wc/v3/orders?per_page=5'],
    ['https://shop.example.test/sklep/?rest_route=/#top', 'https://shop.example.test/sklep/wp-json/wc/v3/orders?per_page=5'],
    ['https://admin:hunter22@shop.example.test/', 'https://shop.example.test/wp-json/wc/v3/orders?per_page=5'],
    ['HTTPS://Shop.Example.Test', 'https://shop.example.test/wp-json/wc/v3/orders?per_page=5'],
  ])('%s → %s', (storeUrl, expected) => {
    expect(apiUrl(storeUrl, 'orders', { per_page: 5 }).toString()).toBe(expected)
  })

  it('keeps a "?" or "#" in a path inside the path', () => {
    const url = apiUrl('https://shop.example.test', 'orders/39?force=true#x')
    expect(url.pathname).toBe('/wp-json/wc/v3/orders/39%3Fforce=true%23x')
    expect(url.search).toBe('')
    expect(url.hash).toBe('')
  })

  it.each(['http://shop.example.test', 'ftp://shop.example.test', 'shop.example.test', '', 'https://'])('refuses %j as permanent, before any request', async (storeUrl) => {
    expect(() => apiUrl(storeUrl, 'orders')).toThrow(PermanentError)
    const { ctx, calls } = context(() => json([]), storeUrl)
    await expect(request(ctx, { path: 'orders', schema, what: 'orders' })).rejects.toBeInstanceOf(PermanentError)
    expect(calls).toEqual([])
  })

  it('does not repeat the address in that error: it may hold a password', () => {
    expect(() => apiUrl('http://admin:hunter22@shop.example.test', 'orders')).toThrow(/^The shop address of the Connection must start with https:\/\/$/)
  })
})

describe('authorization', () => {
  it('is HTTP Basic with the key as the user name', () => {
    expect(authorization(credentials)).toBe(`Basic ${Buffer.from('ck_test_consumer_key:cs_test_consumer_secret').toString('base64')}`)
  })

  it('does not throw on a character outside Latin-1 that somebody pasted', () => {
    expect(authorization({ consumerKey: 'ck_ż', consumerSecret: 'cs_✓' })).toBe(`Basic ${Buffer.from('ck_ż:cs_✓', 'utf8').toString('base64')}`)
  })

  it('does not throw on a value far longer than a key is', () => {
    const long = { consumerKey: 'k'.repeat(300_000), consumerSecret: 's'.repeat(300_000) }
    expect(authorization(long)).toBe(`Basic ${Buffer.from(`${long.consumerKey}:${long.consumerSecret}`).toString('base64')}`)
  })
})

describe('request', () => {
  it('sends a GET with the key, asking for JSON, and never follows a redirect', async () => {
    const { ctx, calls } = context(() => json([{ id: 39 }]))
    const response = await request(ctx, { path: 'orders', query: { per_page: 5 }, schema, what: 'orders' })
    expect(response.data).toEqual([{ id: 39 }])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://shop.example.test/wp-json/wc/v3/orders?per_page=5')
    expect(calls[0]!.init).toEqual({
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': USER_AGENT, authorization: authorization(credentials) },
      body: undefined,
      redirect: 'manual',
    })
  })

  it('says who is asking, the same on every request: a firewall often blocks the "node" fetch sends by itself', async () => {
    expect(USER_AGENT).toBe('Hanza-WooCommerce-Connector (+https://github.com/evelumo/hanza)')
    const order = z.object({ id: z.number() })
    const { ctx, calls } = context(() => json({ id: 39 }))
    await request(ctx, { path: 'orders/39', schema: order, what: 'order' })
    await request(ctx, { method: 'PUT', path: 'orders/39', body: { status: 'completed' }, schema: order, what: 'order' })
    await request(ctx, { method: 'POST', path: 'products/batch', body: { update: [] }, schema: z.unknown(), what: 'stock update' })
    await requestIfFound(ctx, { path: 'orders/39', schema: order, what: 'order' })
    await requestIfAllowed(ctx, { path: 'data/currencies/current', schema: z.unknown(), what: 'currency' })
    expect(calls).toHaveLength(5)
    for (const call of calls) expect(call.init.headers).toMatchObject({ 'user-agent': USER_AGENT })
  })

  it('sends a body as JSON', async () => {
    const { ctx, calls } = context(() => json({ id: 39 }))
    await request(ctx, { method: 'PUT', path: 'orders/39', body: { status: 'completed' }, schema: z.object({ id: z.number() }), what: 'order' })
    expect(calls[0]!.init).toMatchObject({
      method: 'PUT',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: authorization(credentials) },
      body: '{"status":"completed"}',
    })
  })

  it('never puts the key in the URL', async () => {
    const { ctx, calls } = context(() => json([]))
    await request(ctx, { path: 'orders', schema, what: 'orders' })
    expect(calls[0]!.url).not.toMatch(/ck_|cs_|consumer/)
  })

  describe('what a list answer says besides its body', () => {
    // The headers of `GET orders?per_page=5&page=2` on the sandbox.
    const page2 = {
      date: 'Sat, 10 Oct 2026 18:57:51 GMT',
      link: '<https://shop.example.test/wp-json/wc/v3/orders?per_page=5&page=1>; rel="prev", <https://shop.example.test/wp-json/wc/v3/orders?per_page=5&page=3>; rel="next"',
      'x-wp-total': '12',
      'x-wp-totalpages': '3',
    }

    it('the shop\'s clock, whether a page follows, and the number of pages', async () => {
      const { ctx } = context(() => json([{ id: 1 }], { headers: page2 }))
      const response = await request(ctx, { path: 'orders', query: { per_page: 5, page: 2 }, schema, what: 'orders' })
      expect(response).toEqual({ data: [{ id: 1 }], shopTimeMs: Date.UTC(2026, 9, 10, 18, 57, 51), hasNextPage: true, totalPages: 3 })
    })

    it('no next page on the last one: every WordPress answer has a Link header, only rel="next" counts', async () => {
      const last = { ...page2, link: '<https://shop.example.test/wp-json/>; rel="https://api.w.org/"', 'x-wp-totalpages': '1' }
      const { ctx } = context(() => json([], { headers: last }))
      expect((await request(ctx, { path: 'orders', schema, what: 'orders' })).hasNextPage).toBe(false)
      const beyond = { ...page2, link: '<https://shop.example.test/wp-json/wc/v3/orders?per_page=5&page=0>; rel="prev"', 'x-wp-total': '0', 'x-wp-totalpages': '0' }
      const { ctx: other } = context(() => json([], { headers: beyond }))
      expect((await request(other, { path: 'orders', query: { page: 99 }, schema, what: 'orders' })).hasNextPage).toBe(false)
    })

    it('falls back to the page count when a proxy dropped the Link header', async () => {
      const { link: _link, ...withoutLink } = page2
      const { ctx } = context(() => json([], { headers: withoutLink }))
      expect((await request(ctx, { path: 'orders', query: { page: 2 }, schema, what: 'orders' })).hasNextPage).toBe(true)
      expect((await request(ctx, { path: 'orders', query: { page: 3 }, schema, what: 'orders' })).hasNextPage).toBe(false)
      // No `page` is page 1.
      expect((await request(ctx, { path: 'orders', schema, what: 'orders' })).hasNextPage).toBe(true)
    })

    it('null for a clock or a number of pages the answer does not carry', async () => {
      const { ctx } = context(() => json([]))
      expect(await request(ctx, { path: 'orders', schema, what: 'orders' })).toEqual({ data: [], shopTimeMs: null, hasNextPage: false, totalPages: null })
    })
  })

  describe('failures', () => {
    it.each([
      ['an unknown key', () => wooError(401, 'woocommerce_rest_cannot_view', 'Sorry, you cannot list resources.'), AuthExpiredError, '401'],
      ['a wrong secret', () => wooError(401, 'woocommerce_rest_authentication_error', 'Consumer secret is invalid.'), AuthExpiredError, '401'],
      ['a read-only key on a write', () => wooError(401, 'woocommerce_rest_authentication_error', 'The API key provided does not have write permissions.'), AuthExpiredError, '401'],
      // No sign-in prompt: the key is fine, its user may not do this.
      ['a key whose user may not manage the shop', () => wooError(403, 'woocommerce_rest_cannot_view', 'Sorry, you cannot list resources.'), PermanentError, '403'],
      ['an order that does not exist', () => wooError(404, 'woocommerce_rest_shop_order_invalid_id', 'Invalid ID.'), PermanentError, '404'],
      ['a bad parameter', () => wooError(400, 'rest_invalid_param', 'Invalid parameter(s): status'), PermanentError, '400'],
      ['too many batch items', () => wooError(413, 'woocommerce_rest_request_entity_too_large', 'Unable to accept more than 100 items for this request.'), PermanentError, '413'],
      ['a host that limits requests', () => new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }), RateLimitedError, '429'],
      ['a server error', () => new Response('<h1>Error establishing a database connection</h1>', { status: 500 }), TransientError, '500'],
      ['a gateway timeout', () => new Response('', { status: 504 }), TransientError, '504'],
      ['a redirect, which is not followed', () => new Response(null, { status: 301, headers: { location: 'https://www.shop.example.test/wp-json/wc/v3/orders' } }), PermanentError, '301'],
    ])('%s', async (_, answer, errorClass, status) => {
      const { ctx } = context(answer)
      const error = await request(ctx, { path: 'orders', schema, what: 'orders' }).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(errorClass)
      expect((error as Error).constructor).toBe(errorClass)
      expect((error as Error).message).toContain(status)
    })

    it('keeps the wait a 429 asks for', async () => {
      const { ctx } = context(() => new Response('', { status: 429, headers: { 'retry-after': '7' } }))
      await expect(request(ctx, { path: 'orders', schema, what: 'orders' })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 7000 })
    })

    it('never repeats the answer, the key or the address in an error', async () => {
      const { ctx } = context(() => wooError(401, 'woocommerce_rest_authentication_error', 'Consumer secret is invalid.'))
      const error = (await request(ctx, { path: 'orders', schema, what: 'orders' }).catch((caught: unknown) => caught)) as Error
      expect(error.message).toBe('401')
      expect(JSON.stringify({ ...error, message: error.message })).not.toMatch(/Consumer secret|ck_|cs_|Basic/)
    })

    it('lets a ConnectorError from ctx.fetch through unchanged: the core\'s rate limiter rejects before sending', async () => {
      const limited = new RateLimitedError('Rate limit reached', { retryAfterMs: 1234 })
      const { ctx } = context(() => Promise.reject(limited))
      await expect(request(ctx, { path: 'orders', schema, what: 'orders' })).rejects.toBe(limited)
    })

    it.each([
      ['a network failure', new TypeError('fetch failed')],
      ['a timeout', new DOMException('The operation timed out', 'TimeoutError')],
      ['anything else', 'boom'],
    ])('wraps %s as transient, keeping the cause', async (_, failure) => {
      const { ctx } = context(() => Promise.reject(failure))
      const error = (await request(ctx, { path: 'orders', schema, what: 'orders' }).catch((caught: unknown) => caught)) as TransientError
      expect(error).toBeInstanceOf(TransientError)
      expect(error.cause).toBe(failure)
      expect(error.message).toBe('The shop could not be reached')
    })

    it('reports an answer of another shape as permanent, by path and never by value', async () => {
      const { ctx } = context(() => json([{ id: 39 }, { id: 'forty', billing: { email: 42 } }, { id: 41, billing: { email: 'jan.testowy@example.test' } }, { billing: 'Jan Testowy' }]))
      const error = (await request(ctx, { path: 'orders', schema, what: 'orders' }).catch((caught: unknown) => caught)) as Error
      expect(error).toBeInstanceOf(PermanentError)
      expect(error.message).toBe('Unexpected orders response from the shop: 1.id (invalid_type), 1.billing.email (invalid_type), 3.id (invalid_type), 3.billing (invalid_type)')
      expect(error.message).not.toMatch(/forty|42|Jan|Testowy|example\.test/)
      expect(error.cause).toBeUndefined()
    })

    it('reports a body that is not JSON (a firewall\'s page behind a 200) as permanent', async () => {
      const { ctx } = context(() => new Response('<html><body>Checking your browser…</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }))
      const error = (await request(ctx, { path: 'orders', schema, what: 'orders' }).catch((caught: unknown) => caught)) as Error
      expect(error).toBeInstanceOf(PermanentError)
      expect(error.message).toBe('Unexpected orders response from the shop: not JSON')
    })

    it('refuses an answer that declares more than the limit, without reading it', async () => {
      let read = 0
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            read++
            controller.enqueue(new TextEncoder().encode('[]'))
            controller.close()
          },
        },
        // Nothing is taken from the source until somebody reads.
        { highWaterMark: 0 },
      )
      const { ctx } = context(() => new Response(body, { headers: { 'content-type': 'application/json', 'content-length': String(MAX_RESPONSE_BYTES + 1) } }))
      const error = (await request(ctx, { path: 'orders', schema, what: 'orders' }).catch((caught: unknown) => caught)) as Error
      expect(error).toBeInstanceOf(PermanentError)
      expect(error.message).toBe('Unexpected orders response from the shop: larger than 20 MB')
      expect(read).toBe(0)
    })

    it('reads an answer that declares exactly the limit', async () => {
      const { ctx } = context(() => json([{ id: 39 }], { headers: { 'content-type': 'application/json', 'content-length': String(MAX_RESPONSE_BYTES) } }))
      expect((await request(ctx, { path: 'orders', schema, what: 'orders' })).data).toEqual([{ id: 39 }])
    })

    it('stops reading an answer without a declared length (sent in chunks) once it passes the limit', async () => {
      const megabyte = new Uint8Array(1024 * 1024).fill(0x20)
      let sent = 0
      let cancelled = false
      const endless = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            sent++
            controller.enqueue(megabyte)
          },
          cancel() {
            cancelled = true
          },
        },
        { highWaterMark: 0 },
      )
      const { ctx } = context(() => new Response(endless, { headers: { 'content-type': 'application/json' } }))
      const error = (await request(ctx, { path: 'orders', schema, what: 'orders' }).catch((caught: unknown) => caught)) as Error
      expect(error).toBeInstanceOf(PermanentError)
      expect(error.message).toBe('Unexpected orders response from the shop: larger than 20 MB')
      expect(cancelled).toBe(true)
      // The megabyte that passed the limit, and no more than the stream had ready behind it.
      expect(sent).toBeGreaterThan(20)
      expect(sent).toBeLessThan(25)
    })

    it('reads an answer that arrives in pieces, also one cut in the middle of a character', async () => {
      const bytes = new TextEncoder().encode(JSON.stringify([{ id: 39, billing: { email: 'żółw@example.test' } }]))
      const cut = bytes.indexOf(0xc5) + 1
      const pieces = [bytes.slice(0, cut), bytes.slice(cut)]
      const body = new ReadableStream<Uint8Array>({ pull: (controller) => (pieces.length > 0 ? controller.enqueue(pieces.shift()!) : controller.close()) })
      const { ctx } = context(() => new Response(body, { headers: { 'content-type': 'application/json' } }))
      expect((await request(ctx, { path: 'orders', schema, what: 'orders' })).data).toEqual([{ id: 39, billing: { email: 'żółw@example.test' } }])
    })

    it('reports an answer that breaks off after its headers as transient: the next attempt may get all of it', async () => {
      const dropped = new TypeError('terminated')
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(dropped)
        },
      })
      const { ctx } = context(() => new Response(body, { headers: { 'content-type': 'application/json' } }))
      const error = (await request(ctx, { path: 'orders', schema, what: 'orders' }).catch((caught: unknown) => caught)) as TransientError
      expect(error).toBeInstanceOf(TransientError)
      expect(error.message).toBe("The shop's orders response broke off")
      expect(error.cause).toBe(dropped)
    })

    it('reports an empty 200 as not JSON', async () => {
      const { ctx } = context(() => new Response(null, { status: 200 }))
      await expect(request(ctx, { path: 'orders', schema, what: 'orders' })).rejects.toThrow('Unexpected orders response from the shop: not JSON')
    })

    it('names the root for an answer that is JSON of the wrong kind, and caps a long list of paths', async () => {
      const { ctx } = context(() => json({ code: 'rest_no_route' }))
      await expect(request(ctx, { path: 'orders', schema, what: 'orders' })).rejects.toThrow('Unexpected orders response from the shop: (root) (invalid_type)')
      const { ctx: many } = context(() => json(Array.from({ length: 25 }, () => ({ id: 'x' }))))
      const error = (await request(many, { path: 'orders', schema, what: 'orders' }).catch((caught: unknown) => caught)) as Error
      expect(error.message).toMatch(/9\.id \(invalid_type\) and 15 more$/)
    })
  })
})

describe('a write the shop answers with 401', () => {
  // WooCommerce's answers on the sandbox: the same code for a key that may only read and for a wrong secret.
  const noWritePermission = () => wooError(401, 'woocommerce_rest_authentication_error', 'The API key provided does not have write permissions.')
  const wrongSecret = () => wooError(401, 'woocommerce_rest_authentication_error', 'Consumer secret is invalid.')
  const order = z.object({ id: z.number(), status: z.string() })
  const put = (ctx: ClientContext) => request(ctx, { method: 'PUT', path: 'orders/39', query: { _fields: ['id', 'status'] }, body: { status: 'completed' }, schema: order, what: 'order' })
  const PROBE = 'https://shop.example.test/wp-json/wc/v3/products?per_page=1&_fields=id'
  /** Answers the write with `write` and the read that follows with `read`. */
  const shop = (write: () => Response, read: () => Response | Promise<Response>) => context((call) => (call.init.method === 'GET' ? read() : write()))

  it('asks once whether the key can read, and says the key is read-only when it can', async () => {
    const { ctx, calls } = shop(noWritePermission, () => json([{ id: 10 }]))
    const error = (await put(ctx).catch((caught: unknown) => caught)) as PermanentError
    expect(error).toBeInstanceOf(PermanentError)
    expect(error.constructor).toBe(PermanentError)
    expect(error.message).toBe('The WooCommerce API key is read-only: create a key with Read/Write permission')
    expect(error.message).toBe(READ_ONLY_KEY_MESSAGE)
    expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual(['PUT https://shop.example.test/wp-json/wc/v3/orders/39?_fields=id%2Cstatus', `GET ${PROBE}`])
    // The read is a request like any other: the key in its header, nothing sent, no redirect followed.
    expect(calls[1]!.init).toEqual({
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': USER_AGENT, authorization: authorization(credentials) },
      body: undefined,
      redirect: 'manual',
    })
    expect(JSON.stringify({ ...error, message: error.message })).not.toMatch(/ck_|cs_|Basic|write permissions/)
  })

  it('goes by the status of the read alone: what it answers is not read', async () => {
    const { ctx } = shop(noWritePermission, () => new Response('<html>not what was asked for</html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    await expect(put(ctx)).rejects.toThrow(READ_ONLY_KEY_MESSAGE)
    const { ctx: empty } = shop(noWritePermission, () => json([]))
    await expect(put(empty)).rejects.toThrow(READ_ONLY_KEY_MESSAGE)
  })

  it('asks for sign-in when the read is refused with 401 as well: the key is not accepted at all', async () => {
    const { ctx, calls } = shop(wrongSecret, wrongSecret)
    const error = (await put(ctx).catch((caught: unknown) => caught)) as Error
    expect(error.constructor).toBe(AuthExpiredError)
    expect(error.message).toBe('401')
    expect(calls).toHaveLength(2)
  })

  it.each([
    ['is forbidden (403)', () => wooError(403, 'woocommerce_rest_cannot_view', 'Sorry, you cannot list resources.')],
    ['finds no API (404)', () => wooError(404, 'rest_no_route', 'No route was found matching the URL and request method.')],
    ['is limited (429)', () => new Response('slow down', { status: 429, headers: { 'retry-after': '7' } })],
    ['fails (500)', () => new Response('<h1>Error establishing a database connection</h1>', { status: 500 })],
    ['is redirected (301)', () => new Response(null, { status: 301, headers: { location: 'https://www.shop.example.test/' } })],
    ['does not reach the shop', () => Promise.reject(new TypeError('fetch failed'))],
    ['is refused by the core\'s rate limiter', () => Promise.reject(new RateLimitedError('Rate limit reached', { retryAfterMs: 1234 }))],
  ])('still asks for sign-in when the read %s: only a read that worked speaks against a sign-out', async (_, read) => {
    const { ctx, calls } = shop(noWritePermission, read)
    const error = (await put(ctx).catch((caught: unknown) => caught)) as Error
    expect(error.constructor).toBe(AuthExpiredError)
    expect(error.message).toBe('401')
    expect(calls).toHaveLength(2)
  })

  it('does the same for a POST, and through requestIfFound and requestIfAllowed', async () => {
    const batch = { method: 'POST', path: 'products/batch', body: { update: [] }, schema: z.unknown(), what: 'stock update' } as const
    for (const send of [request, requestIfFound, requestIfAllowed]) {
      const readOnly = shop(noWritePermission, () => json([]))
      await expect(send(readOnly.ctx, batch)).rejects.toThrow(READ_ONLY_KEY_MESSAGE)
      expect(readOnly.calls.map((call) => call.init.method)).toEqual(['POST', 'GET'])
      const signedOut = shop(wrongSecret, wrongSecret)
      await expect(send(signedOut.ctx, batch)).rejects.toBeInstanceOf(AuthExpiredError)
    }
  })

  it('does not ask after a read that got a 401: that is a sign-out', async () => {
    const { ctx, calls } = context(wrongSecret)
    for (const send of [request, requestIfFound, requestIfAllowed]) {
      await expect(send(ctx, { path: 'orders', schema, what: 'orders' })).rejects.toBeInstanceOf(AuthExpiredError)
    }
    expect(calls).toHaveLength(3)
  })

  it.each([400, 403, 404, 413, 429, 500])('does not ask after a write that got a %i', async (status) => {
    const { ctx, calls } = context(() => new Response(null, { status }))
    const error = (await put(ctx).catch((caught: unknown) => caught)) as Error
    expect(error.message).not.toBe(READ_ONLY_KEY_MESSAGE)
    expect(error.constructor).not.toBe(AuthExpiredError)
    expect(calls).toHaveLength(1)
  })
})

describe('requestIfFound', () => {
  const order = z.object({ id: z.number() })

  it('resolves like request for a 2xx', async () => {
    const { ctx } = context(() => json({ id: 39 }, { headers: { date: 'Sat, 10 Oct 2026 18:57:51 GMT' } }))
    expect(await requestIfFound(ctx, { path: 'orders/39', schema: order, what: 'order' })).toMatchObject({ data: { id: 39 }, shopTimeMs: Date.UTC(2026, 9, 10, 18, 57, 51) })
  })

  it.each(['woocommerce_rest_shop_order_invalid_id', 'woocommerce_rest_product_invalid_id', 'woocommerce_rest_product_variation_invalid_id', 'woocommerce_rest_invalid_product_id'])(
    'is null for a 404 with WooCommerce\'s %s',
    async (code) => {
      const { ctx } = context(() => wooError(404, code, 'Invalid ID.'))
      expect(await requestIfFound(ctx, { path: 'orders/999999', schema: order, what: 'order' })).toBeNull()
    },
  )

  it('fails for a 404 that means the API is not there (wrong address, plain permalinks)', async () => {
    const { ctx } = context(() => wooError(404, 'rest_no_route', 'No route was found matching the URL and request method.'))
    await expect(requestIfFound(ctx, { path: 'orders/39', schema: order, what: 'order' })).rejects.toBeInstanceOf(PermanentError)
    const { ctx: html } = context(() => new Response('<h1>Not Found</h1>', { status: 404, headers: { 'content-type': 'text/html' } }))
    await expect(requestIfFound(html, { path: 'orders/39', schema: order, what: 'order' })).rejects.toBeInstanceOf(PermanentError)
  })

  it('fails for any other status, also with that code (a PUT to a deleted order answers 400)', async () => {
    const { ctx } = context(() => wooError(400, 'woocommerce_rest_shop_order_invalid_id', 'ID is invalid.'))
    await expect(requestIfFound(ctx, { method: 'PUT', path: 'orders/999999', body: { status: 'completed' }, schema: order, what: 'order' })).rejects.toBeInstanceOf(PermanentError)
    const { ctx: unauthorized } = context(() => wooError(401, 'woocommerce_rest_cannot_view', 'Sorry, you cannot view this resource.'))
    await expect(requestIfFound(unauthorized, { path: 'orders/39', schema: order, what: 'order' })).rejects.toBeInstanceOf(AuthExpiredError)
  })

  it('does not read a 404 larger than any error of WooCommerce to learn what it means', async () => {
    const huge = JSON.stringify({ code: 'woocommerce_rest_shop_order_invalid_id', message: 'x'.repeat(100_000), data: { status: 404 } })
    const { ctx } = context(() => new Response(huge, { status: 404, headers: { 'content-type': 'application/json' } }))
    await expect(requestIfFound(ctx, { path: 'orders/39', schema: order, what: 'order' })).rejects.toBeInstanceOf(PermanentError)
  })
})

describe('requestIfAllowed', () => {
  const currency = z.object({ code: z.string() })

  it('resolves like request for a 2xx', async () => {
    const { ctx, calls } = context(() => json({ code: 'PLN' }, { headers: { date: 'Sat, 10 Oct 2026 18:57:51 GMT' } }))
    expect(await requestIfAllowed(ctx, { path: 'data/currencies/current', schema: currency, what: 'currency' })).toEqual({
      data: { code: 'PLN' },
      shopTimeMs: Date.UTC(2026, 9, 10, 18, 57, 51),
      hasNextPage: false,
      totalPages: null,
    })
    expect(calls[0]!.url).toBe('https://shop.example.test/wp-json/wc/v3/data/currencies/current')
  })

  it.each([
    // As the sandbox answered a key whose user may not manage WooCommerce.
    ['WooCommerce\'s own refusal', () => wooError(403, 'woocommerce_rest_cannot_view', 'Sorry, you cannot view this resource.')],
    ['a bare 403', () => new Response(null, { status: 403, statusText: 'Forbidden' })],
    ['a firewall\'s page', () => new Response('<h1>Forbidden</h1>', { status: 403, headers: { 'content-type': 'text/html' } })],
  ])('is null for a 403: %s', async (_, answer) => {
    const { ctx } = context(answer)
    expect(await requestIfAllowed(ctx, { path: 'data/currencies/current', schema: currency, what: 'currency' })).toBeNull()
  })

  it.each([
    [401, AuthExpiredError],
    [404, PermanentError],
    [429, RateLimitedError],
    [500, TransientError],
    [301, PermanentError],
  ])('fails for a %i like request does', async (status, errorClass) => {
    const { ctx } = context(() => new Response(null, { status }))
    await expect(requestIfAllowed(ctx, { path: 'data/currencies/current', schema: currency, what: 'currency' })).rejects.toBeInstanceOf(errorClass)
  })

  it('fails for a 200 of another shape: allowed, and not what was asked for', async () => {
    const { ctx } = context(() => json({ currency: 'PLN' }))
    await expect(requestIfAllowed(ctx, { path: 'data/currencies/current', schema: currency, what: 'currency' })).rejects.toThrow('Unexpected currency response from the shop: code (invalid_type)')
  })
})

describe('the header helpers', () => {
  it('shopTimeFrom is null for a missing or unreadable Date', () => {
    expect(shopTimeFrom(new Headers({ date: 'Sat, 10 Oct 2026 18:57:51 GMT' }))).toBe(Date.UTC(2026, 9, 10, 18, 57, 51))
    expect(shopTimeFrom(new Headers())).toBeNull()
    expect(shopTimeFrom(new Headers({ date: 'soon' }))).toBeNull()
  })

  it('hasNextPageFrom reads rel=next wherever it stands in the header', () => {
    expect(hasNextPageFrom(new Headers({ link: '<https://shop.example.test/wp-json/wc/v3/orders?page=2>; rel="next"' }), 1)).toBe(true)
    expect(hasNextPageFrom(new Headers({ link: '<https://shop.example.test/x?page=3>; rel=next, <https://shop.example.test/x?page=1>; rel="prev"' }), 2)).toBe(true)
    expect(hasNextPageFrom(new Headers({ link: '<https://shop.example.test/wp-json/>; rel="https://api.w.org/"' }), 1)).toBe(false)
    expect(hasNextPageFrom(new Headers(), 1)).toBe(false)
  })
})
