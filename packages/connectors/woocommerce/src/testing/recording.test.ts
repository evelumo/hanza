import { Scrubber } from '@hanza/connector-sdk/testing'
import { describe, expect, it } from 'vitest'
import { wooOrderSchema } from '../api'
import { mapOrder } from '../mapping/order'
import { blanksToNull, RECORDING_STORE_URL, replayConfig, replayCredentials, sandboxFetch, unauthorizedCredentials } from './recording'
import { EMPTY_ADDRESS, rawOrder, rawSimpleProduct } from './samples'
import { woocommerceScrub } from './scrub'
import { configSchema, credentialsSchema } from '../settings'

const scrubbed = (body: unknown) => new Scrubber(woocommerceScrub).json(body, []) as Record<string, any>

describe('woocommerceScrub', () => {
  it('replaces everything about a person in an order and keeps what the connector maps', () => {
    const order = scrubbed(blanksToNull(rawOrder({ customer_note: 'Proszę zostawić paczkę u sąsiada spod numeru 4.' })))
    const text = JSON.stringify(order)
    for (const personal of ['Ewa', 'Fikcyjna', 'Marek', 'Odbiorca', 'Wymyślona', 'Magazynowa', 'Wrocław', 'Łódź', '50-001', '90-001', '000 000', 'ewa.fikcyjna', '192.0.2.19', 'HanzaSandboxBrowser', 'SANDBOX-TXN', 'sąsiada', 'wc_order_SampleOrderKey']) {
      expect(text).not.toContain(personal)
    }
    expect(order.billing).toMatchObject({ first_name: 'scrubbed-1', last_name: 'scrubbed-2', country: 'PL', email: 'person-1@example.com', phone: '+00000000001' })
    expect(order.shipping.country).toBe('PL')
    expect(order.order_key).toBe('[scrubbed]')
    expect(order.payment_url).toBe('https://shop.example.test/checkout/order-pay/39/?pay_for_order=true&key=[scrubbed]')
    expect(order).toMatchObject({ id: 39, status: 'processing', total: '426.96', payment_method: 'przelewy24', date_paid_gmt: '2026-09-21T07:22:00' })
    expect(order.line_items[0]).toMatchObject({ name: 'Koszulka testowa - S', sku: 'WOO-TSHIRT-S', total: '126.13', total_tax: '29.01', product_id: 19, variation_id: 20 })
  })

  it('leaves a scrubbed order mapping to the same Order, with placeholders for the person', () => {
    const live = mapOrder(wooOrderSchema.parse(rawOrder()))
    const replayed = mapOrder(wooOrderSchema.parse(scrubbed(blanksToNull(rawOrder()))))
    if (!live.fits || !replayed.fits) throw new Error('does not fit')
    expect(replayed.order.lines).toEqual(live.order.lines)
    expect(replayed.order.facts).toEqual(live.order.facts)
    expect(replayed.order.total).toEqual(live.order.total)
    expect(replayed.order.shippingAddress).toEqual({ name: 'scrubbed-7 scrubbed-8', company: 'scrubbed-9', street: 'scrubbed-10', postalCode: 'scrubbed-12', city: 'scrubbed-11', countryCode: 'PL', phone: '+00000000002', taxId: null })
    expect(replayed.order.billingAddress?.company).toBe('scrubbed-3')
  })

  it('leaves a product as it is: nothing in it is about a person', () => {
    const { meta_data: _meta, ...product } = rawSimpleProduct()
    expect(scrubbed(product)).toEqual(product)
  })

  it('keeps the response headers the connector reads', () => {
    const scrubber = new Scrubber(woocommerceScrub)
    const kept = scrubber.interaction({
      request: { method: 'GET', url: 'https://shop.example.test/wp-json/wc/v3/orders', headers: { accept: 'application/json', authorization: 'Basic Y2tfeDpjc194' }, body: null },
      response: {
        status: 200,
        headers: { date: 'Sat, 10 Oct 2026 18:57:51 GMT', link: '<https://shop.example.test/wp-json/wc/v3/orders?page=2>; rel="next"', 'x-wp-total': '12', 'x-wp-totalpages': '3', server: 'Apache/2.4.68 (Debian)', 'x-powered-by': 'PHP/8.3.35' },
        body: { json: [] },
      },
    })
    expect(kept.request.headers).toEqual({ accept: 'application/json' })
    expect(kept.response.headers).toEqual({ date: 'Sat, 10 Oct 2026 18:57:51 GMT', link: '<https://shop.example.test/wp-json/wc/v3/orders?page=2>; rel="next"', 'x-wp-total': '12', 'x-wp-totalpages': '3' })
  })
})

describe('blanksToNull', () => {
  it('turns the empty strings of personal fields into nulls, at any depth, and nothing else', () => {
    expect(blanksToNull([{ id: 1, status: '', cart_hash: '', billing: { first_name: '', company: 'Firma', country: '', email: '' }, line_items: [{ sku: '', name: '' }] }])).toEqual([
      { id: 1, status: '', cart_hash: null, billing: { first_name: null, company: 'Firma', country: '', email: null }, line_items: [{ sku: '', name: '' }] },
    ])
  })

  it('is why an empty shipping address is still empty after scrubbing', () => {
    // Without it the scrubber fills every empty field of the address with a placeholder.
    const filled = scrubbed(rawOrder({ shipping: EMPTY_ADDRESS }))
    expect(filled.shipping.first_name).toMatch(/^scrubbed-\d+$/)

    const virtual = wooOrderSchema.parse(scrubbed(blanksToNull(rawOrder({ shipping: EMPTY_ADDRESS }))))
    const mapped = mapOrder(virtual)
    if (!mapped.fits) throw new Error('does not fit')
    expect(mapped.order.shippingAddress).toEqual(mapped.order.billingAddress)
    expect(mapped.order.billingAddress?.company).toBe('scrubbed-3')
  })
})

describe('sandboxFetch', () => {
  function sandbox(answer: () => Response) {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = []
    const transport: typeof fetch = async (input, init = {}) => {
      calls.push({
        url: String(input),
        method: init.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init.headers)),
        body: init.body ? new TextDecoder().decode(init.body as ArrayBuffer) : '',
      })
      return answer()
    }
    return { fetch: sandboxFetch('http://127.0.0.1:8089', transport), calls }
  }

  it('sends a request for the neutral address to the sandbox, saying it came over TLS', async () => {
    const { fetch, calls } = sandbox(() => new Response('[]', { headers: { 'content-type': 'application/json' } }))
    await fetch(`${RECORDING_STORE_URL}/wp-json/wc/v3/orders?status=pending%2Con-hold&per_page=5`, { headers: { accept: 'application/json', authorization: 'Basic abc' } })
    await fetch(`${RECORDING_STORE_URL}/wp-json/wc/v3/orders/39`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"status":"completed"}' })
    expect(calls[0]).toEqual({
      url: 'http://127.0.0.1:8089/wp-json/wc/v3/orders?status=pending%2Con-hold&per_page=5',
      method: 'GET',
      headers: { accept: 'application/json', authorization: 'Basic abc', 'x-forwarded-proto': 'https' },
      body: '',
    })
    expect(calls[1]).toMatchObject({ url: 'http://127.0.0.1:8089/wp-json/wc/v3/orders/39', method: 'PUT', body: '{"status":"completed"}' })
  })

  it('hands back the answer with its status and headers, blanks as nulls', async () => {
    const { fetch } = sandbox(
      () => new Response(JSON.stringify({ id: 40, shipping: EMPTY_ADDRESS }), { status: 200, headers: { 'content-type': 'application/json; charset=UTF-8', date: 'Sat, 10 Oct 2026 18:57:51 GMT', 'x-wp-total': '1' } }),
    )
    const response = await fetch(`${RECORDING_STORE_URL}/wp-json/wc/v3/orders/40`)
    expect(response.status).toBe(200)
    expect(response.headers.get('date')).toBe('Sat, 10 Oct 2026 18:57:51 GMT')
    expect(response.headers.get('x-wp-total')).toBe('1')
    expect(await response.json()).toEqual({ id: 40, shipping: { ...Object.fromEntries(Object.keys(EMPTY_ADDRESS).map((key) => [key, null])), country: '' } })
  })

  it('passes an error answer and a body that is not JSON through', async () => {
    const { fetch } = sandbox(() => new Response('<h1>Bad gateway</h1>', { status: 502, headers: { 'content-type': 'text/html' } }))
    const response = await fetch(`${RECORDING_STORE_URL}/wp-json/wc/v3/orders`)
    expect(response.status).toBe(502)
    expect(await response.text()).toBe('<h1>Bad gateway</h1>')
  })

  it('refuses any other host: a recording never leaves the sandbox', async () => {
    const { fetch, calls } = sandbox(() => new Response('[]'))
    await expect(fetch('https://another-shop.example.test/wp-json/wc/v3/orders')).rejects.toThrow('only forwards https://shop.example.test')
    expect(calls).toEqual([])
  })
})

describe('what a test replays with', () => {
  it('is a valid Connection, with stand-ins long enough for the scrubber to replace', () => {
    expect(configSchema.parse(replayConfig)).toEqual({ storeUrl: 'https://shop.example.test' })
    for (const credentials of [replayCredentials, unauthorizedCredentials]) {
      expect(credentialsSchema.parse(credentials)).toEqual(credentials)
      for (const value of Object.values(credentials)) expect(value.length).toBeGreaterThanOrEqual(8)
    }
  })
})
