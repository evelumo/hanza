import { AuthExpiredError, CursorExpiredError, isCursorExpiredError, PermanentError, RateLimitedError, TransientError } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { hanzaStatusSchema } from './api'
import { apiUrl, authorization, LOCATION_NOT_SET_MESSAGE, PLUGIN_MISSING_MESSAGE, request, USER_AGENT } from './client'
import { readPluginAnswer, readStatus } from './plugin'
import { replayConfig, replayCredentials } from './testing/recording'

function contextAnswering(answer: (request: Request) => Response | Promise<Response>, seen: Request[] = []) {
  return {
    config: replayConfig,
    credentials: replayCredentials,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      seen.push(request)
      return answer(request)
    }) as typeof fetch,
  }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const get = (ctx: ReturnType<typeof contextAnswering>, path = 'orders') => request(ctx, { path, schema: z.object({ ok: z.boolean() }), what: 'test' })

describe('apiUrl', () => {
  it('puts the Admin API below the backend address, also one below a path', () => {
    expect(apiUrl('https://medusa.example.test', 'orders').href).toBe('https://medusa.example.test/admin/orders')
    expect(apiUrl('https://example.test/backend/', 'hanza/status').href).toBe('https://example.test/backend/admin/hanza/status')
  })

  it('sends a list as name[] once per item and operator filters as written, in order', () => {
    const url = apiUrl('https://medusa.example.test', 'orders', [
      ['id', ['order_1', 'order_2']],
      ['created_at[$gte]', '2026-10-11T10:00:00.000Z'],
      ['limit', 100],
      ['skipped', undefined],
    ])
    expect(decodeURIComponent(url.search)).toBe('?id[]=order_1&id[]=order_2&created_at[$gte]=2026-10-11T10:00:00.000Z&limit=100')
  })

  it('refuses an address that is not https, and drops a query or credentials stored before the schema refused them', () => {
    expect(() => apiUrl('http://medusa.example.test', 'orders')).toThrow(PermanentError)
    expect(() => apiUrl('not a url', 'orders')).toThrow(PermanentError)
    expect(apiUrl('https://user:pass@medusa.example.test/?x#y', 'orders').href).toBe('https://medusa.example.test/admin/orders')
  })
})

describe('request', () => {
  it('sends the secret key raw in HTTP Basic, the User-Agent, and no redirect following', async () => {
    const seen: Request[] = []
    await get(contextAnswering(() => json({ ok: true }), seen))
    expect(seen[0]!.headers.get('authorization')).toBe(`Basic ${replayCredentials.apiKey}`)
    expect(authorization(replayCredentials)).toBe('Basic sk_replay_secret_key_for_tests')
    expect(seen[0]!.headers.get('user-agent')).toBe(USER_AGENT)
    expect(seen[0]!.redirect).toBe('manual')
  })

  it.each([
    [401, AuthExpiredError],
    [403, PermanentError],
    [404, PermanentError],
    [400, PermanentError],
    [500, TransientError],
    [503, TransientError],
  ])('maps %i to %s', async (status, kind) => {
    const failure = get(contextAnswering(() => json({ type: 'x', message: 'Buyer Anna Nowak' }, status)))
    await expect(failure).rejects.toBeInstanceOf(kind)
    await expect(failure).rejects.not.toThrow(/Anna/)
  })

  it('maps 429 to a RateLimitedError with the wait Medusa (or its proxy) asked for', async () => {
    const failure = get(contextAnswering(() => json({}, 429, { 'retry-after': '7' })))
    await expect(failure).rejects.toBeInstanceOf(RateLimitedError)
    await expect(failure).rejects.toMatchObject({ retryAfterMs: 7000 })
  })

  it('says the plugin is missing for a 404 on its routes', async () => {
    const failure = get(contextAnswering(() => json({ type: 'not_found', message: 'Cannot GET /admin/hanza/status' }, 404)), 'hanza/status')
    await expect(failure).rejects.toThrow(PLUGIN_MISSING_MESSAGE)
    await expect(failure).rejects.toBeInstanceOf(PermanentError)
  })

  it('maps the journal\'s 410 journal_expired to a CursorExpiredError, and another 410 to a PermanentError', async () => {
    const expired = get(contextAnswering(() => json({ type: 'gone', code: 'journal_expired', message: 'm', oldest_seq: 500 }, 410)), 'hanza/journal')
    await expect(expired).rejects.toBeInstanceOf(CursorExpiredError)
    const other = await get(contextAnswering(() => json({ type: 'gone', code: 'other' }, 410)), 'hanza/journal').catch((error: unknown) => error)
    expect(other).toBeInstanceOf(PermanentError)
    expect(isCursorExpiredError(other)).toBe(false)
  })

  it('tells the person to pick a stock location for the 409 stock_location_not_set', async () => {
    const failure = get(contextAnswering(() => json({ type: 'conflict', code: 'stock_location_not_set', message: 'm' }, 409)), 'hanza/stock')
    await expect(failure).rejects.toThrow(LOCATION_NOT_SET_MESSAGE)
    expect(LOCATION_NOT_SET_MESSAGE).toMatch(/Extensions → Hanza/)
  })

  it('refuses a redirect instead of following it', async () => {
    const failure = get(contextAnswering(() => new Response(null, { status: 301, headers: { location: 'https://elsewhere.example.test/' } })))
    await expect(failure).rejects.toThrow(/redirects elsewhere \(301\)/)
  })

  it('maps a network failure to a TransientError and lets a ConnectorError of ctx.fetch through', async () => {
    await expect(get(contextAnswering(() => Promise.reject(new TypeError('fetch failed'))))).rejects.toBeInstanceOf(TransientError)
    const limited = new RateLimitedError('limited', { retryAfterMs: 1000 })
    await expect(get(contextAnswering(() => Promise.reject(limited)))).rejects.toBe(limited)
  })

  it('refuses an answer that is not JSON or not of the expected shape, naming paths, never values', async () => {
    await expect(get(contextAnswering(() => new Response('<html>maintenance</html>', { status: 200 })))).rejects.toThrow(/not JSON/)
    const shape = get(contextAnswering(() => json({ ok: 'Anna Nowak' })))
    await expect(shape).rejects.toThrow(/ok \(invalid_type\)/)
    await expect(shape).rejects.not.toThrow(/Anna/)
  })
})

const status = {
  format: 1,
  plugin: { name: 'medusa-plugin-hanza', version: '0.1.0' },
  store: { default_currency_code: 'pln' },
  settings: {
    stock_location_id: null,
    sales_channel_ids: [],
    pay_on_delivery_provider_ids: ['pp_system_default'],
    paid_when: 'captured',
    notify_customer_on_shipment: true,
    journal_retention_days: 60,
    currency_code: null,
  },
  journal: { oldest_seq: null, newest_seq: null },
}

describe('the plugin status', () => {
  it('reads the settings and the journal ends', async () => {
    const read = await readStatus(contextAnswering(() => json(status)))
    expect(read.settings.pay_on_delivery_provider_ids).toEqual(['pp_system_default'])
    expect(read.journal).toEqual({ oldest_seq: null, newest_seq: null })
  })

  it('reads a seq sent as text', () => {
    expect(readPluginAnswer({ ...status, journal: { oldest_seq: '12', newest_seq: '980' } }, hanzaStatusSchema, 'status').journal).toEqual({ oldest_seq: 12, newest_seq: 980 })
  })

  it('refuses a wire format it does not know, naming both versions', () => {
    expect(() => readPluginAnswer({ ...status, format: 2, plugin: { name: 'medusa-plugin-hanza', version: '1.4.0' } }, hanzaStatusSchema, 'status')).toThrow(
      'medusa-plugin-hanza "1.4.0" speaks wire format 2; this Hanza understands format 1',
    )
    expect(() => readPluginAnswer({ ...status, format: 'two words <script>' }, hanzaStatusSchema, 'status')).toThrow(/speaks wire format an unknown one/)
  })
})
