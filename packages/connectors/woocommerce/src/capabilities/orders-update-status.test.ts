import { classifyConnectorError, ORDER_PHASES, type OrderPhase } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { createWooCommerceConnector } from '../connector'
import type { WooCommerceContext } from '../settings'
import { replayConfig, replayCredentials } from '../testing/recording'
import { FakeShop } from '../testing/orders-fake-shop'
import { withOrdersScenario } from '../testing/orders-scenario'
import { parseOrderId, updateOrderStatus } from './orders-update-status'

// First against a WooCommerce in memory (`testing/orders-fake-shop.ts`), then against the recorded sandbox shop. To record
// the cassettes again (after the feed's, or on a fresh shop: the orders used here are not touched by those):
//
//   WOO_SANDBOX_PROJECT=<name> WOO_SANDBOX_PORT=<port> HANZA_RECORD_FIXTURES=1 \
//     pnpm --filter @hanza/connector-woocommerce exec vitest run src/capabilities/orders-update-status.test.ts

const RECORDING_TIMEOUT = 120_000

// `packing` stands for a status a plugin registered, as in the sandbox.
const STATUSES = ['pending', 'on-hold', 'processing', 'completed', 'cancelled', 'refunded', 'failed', 'trash', 'packing', 'checkout-draft']

// The spec's "Order phases" table: the status that is set, by the order's status now. Not named: no change.
const TABLE: Record<OrderPhase, Record<string, string>> = {
  new: {},
  processing: { pending: 'processing', 'on-hold': 'processing', failed: 'processing' },
  shipped: { pending: 'completed', 'on-hold': 'completed', processing: 'completed', packing: 'completed' },
  cancelled: { pending: 'cancelled', 'on-hold': 'cancelled', processing: 'cancelled', packing: 'cancelled' },
}

const kindOf = async (call: Promise<unknown>) => classifyConnectorError(await call.then(() => new Error('resolved'), (error: unknown) => error)).kind

describe('parseOrderId', () => {
  it('reads a WooCommerce order id', () => {
    expect(parseOrderId('57')).toBe(57)
    expect(parseOrderId('1')).toBe(1)
  })

  it.each(['', '0', '-5', '1.5', ' 12', '12 ', '012', '19:21', 'abc', '1e3', '99999999999999999999', '9007199254740993'])('refuses %j', (externalId) => {
    expect(parseOrderId(externalId)).toBeNull()
  })
})

describe('orders.updateStatus', () => {
  describe.each(ORDER_PHASES)('phase %s', (phase) => {
    it.each(STATUSES)('an order that is %s', async (status) => {
      const shop = new FakeShop()
      const id = shop.place({ status })
      shop.tick(60)
      await updateOrderStatus(shop.context(), { orderExternalId: String(id), phase })

      const expected = TABLE[phase][status]
      if (phase === 'new') {
        // No status of WooCommerce stands for "new": nothing is asked, not even the order.
        expect(shop.requests).toEqual([])
      } else if (expected === undefined) {
        expect(shop.urls).toEqual([`GET orders/${id}?_fields=id,status`])
      } else {
        expect(shop.urls).toEqual([`GET orders/${id}?_fields=id,status`, `PUT orders/${id}?_fields=id,status`])
        // The status and nothing else: never `set_paid`.
        expect(shop.requests[1]!.body).toEqual({ status: expected })
      }
      expect(shop.get(id).status).toBe(expected ?? status)
    })
  })

  it('sends the status as JSON with the key in the Authorization header', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const ctx: WooCommerceContext = {
      app: {},
      config: replayConfig,
      credentials: replayCredentials,
      fetch: async (input, init = {}) => {
        calls.push({ url: String(input), init })
        return new Response(JSON.stringify({ id: 33, status: init.method === 'PUT' ? 'processing' : 'pending' }), { headers: { 'content-type': 'application/json' } })
      },
      log: () => {},
    }
    await updateOrderStatus(ctx, { orderExternalId: '33', phase: 'processing' })
    expect(calls.map(({ url, init }) => `${init.method} ${url}`)).toEqual([
      'GET https://shop.example.test/wp-json/wc/v3/orders/33?_fields=id%2Cstatus',
      'PUT https://shop.example.test/wp-json/wc/v3/orders/33?_fields=id%2Cstatus',
    ])
    expect(calls[1]!.init.body).toBe('{"status":"processing"}')
    expect(calls[1]!.init.headers).toMatchObject({ 'content-type': 'application/json', authorization: expect.stringMatching(/^Basic /) })
    expect(calls[0]!.init.body).toBeUndefined()
  })

  it('never takes an order out of the trash: any PUT would', async () => {
    const shop = new FakeShop()
    const id = shop.place()
    shop.trash(id)
    const trashedAt = shop.get(id).date_modified_gmt
    shop.tick(60)
    for (const phase of ORDER_PHASES) await updateOrderStatus(shop.context(), { orderExternalId: String(id), phase })
    expect(shop.requests.filter(({ method }) => method === 'PUT')).toEqual([])
    expect(shop.get(id)).toMatchObject({ status: 'trash', date_modified_gmt: trashedAt })
  })

  it('is repeatable: every phase twice, in the order of the conformance kit, against one order', async () => {
    const shop = new FakeShop()
    const id = shop.place({ status: 'on-hold' })
    for (const phase of ORDER_PHASES) {
      for (let attempt = 0; attempt < 2; attempt++) await updateOrderStatus(shop.context(), { orderExternalId: String(id), phase })
    }
    // Moved on once for `processing` and once for `shipped`; the repeats and `cancelled` found nothing to do.
    expect(shop.requests.filter(({ method }) => method === 'PUT').map(({ body }) => body)).toEqual([{ status: 'processing' }, { status: 'completed' }])
    expect(shop.requests).toHaveLength(6 + 2)
    expect(shop.get(id).status).toBe('completed')
  })

  it('an order that no longer exists is a permanent failure', async () => {
    const shop = new FakeShop()
    const error = await updateOrderStatus(shop.context(), { orderExternalId: '999999', phase: 'shipped' }).catch((caught: unknown) => caught)
    expect(classifyConnectorError(error)).toMatchObject({ kind: 'permanent', message: 'Order 999999 no longer exists in the shop' })
    expect(shop.urls).toEqual(['GET orders/999999?_fields=id,status'])
  })

  it('an order deleted between the read and the write is a permanent failure too (WooCommerce answers 400)', async () => {
    const shop = new FakeShop()
    const id = shop.place()
    shop.beforeAnswer = (count) => {
      if (count === 2) shop.remove(id)
    }
    expect(await kindOf(updateOrderStatus(shop.context(), { orderExternalId: String(id), phase: 'shipped' }))).toBe('permanent')
    expect(shop.requests.map(({ method }) => method)).toEqual(['GET', 'PUT'])
  })

  it.each(['', 'abc', '19:21', '0', '-5', '1.5', '99999999999999999999'])('an external id that is not an order id (%j) is a permanent failure without a request', async (orderExternalId) => {
    const shop = new FakeShop()
    for (const phase of ORDER_PHASES) {
      const error = await updateOrderStatus(shop.context(), { orderExternalId, phase }).catch((caught: unknown) => caught)
      expect(classifyConnectorError(error).kind).toBe('permanent')
      // The id may be anything, so it is not repeated.
      if (orderExternalId !== '') expect((error as Error).message).not.toContain(orderExternalId)
    }
    expect(shop.requests).toEqual([])
  })

  describe('a shop that does not answer with the order', () => {
    // Hand-written answers: the sandbox cannot be made to send a 429 or a 500.
    function contextAnswering(answer: (method: string) => Response): WooCommerceContext {
      return { app: {}, config: replayConfig, credentials: replayCredentials, fetch: async (_, init = {}) => answer(init.method ?? 'GET'), log: () => {} }
    }
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
    const wooError = (status: number, code: string, headers: Record<string, string> = {}) => json({ code, message: 'Sorry.', data: { status } }, status, headers)
    const pending = () => json({ id: 33, status: 'pending' })
    const input = { orderExternalId: '33', phase: 'shipped' } as const

    it.each([
      ['an unknown key', () => wooError(401, 'woocommerce_rest_cannot_view'), 'auth_expired'],
      ['a key of a user who may not manage the shop', () => wooError(403, 'woocommerce_rest_cannot_view'), 'permanent'],
      ['a server error', () => wooError(500, 'internal_server_error'), 'transient'],
      ['a firewall page with status 200', () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }), 'permanent'],
      ['an order without a status', () => json({ id: 33 }), 'permanent'],
      // Another 404 than "no such order": the address is wrong, or WooCommerce is switched off.
      ['a 404 that is not about the order', () => wooError(404, 'rest_no_route'), 'permanent'],
    ])('%s on the read is %s, and nothing is written', async (_, answer, kind) => {
      const methods: string[] = []
      const ctx = contextAnswering((method) => {
        methods.push(method)
        return answer()
      })
      expect(await kindOf(updateOrderStatus(ctx, input))).toBe(kind)
      expect(methods).toEqual(['GET'])
    })

    it.each([
      // What a read-only key gets for a write: a 401, like a wrong secret. The client then reads once with the key
      // (here every GET is answered), and a key that can read is not signed out but may not write.
      ['a read-only key', () => wooError(401, 'woocommerce_rest_cannot_edit'), 'permanent'],
      ['a status the shop does not know', () => wooError(400, 'rest_invalid_param'), 'permanent'],
      ['a server error', () => wooError(503, 'service_unavailable'), 'transient'],
    ])('%s on the write is %s', async (_, answer, kind) => {
      expect(await kindOf(updateOrderStatus(contextAnswering((method) => (method === 'GET' ? pending() : answer())), input))).toBe(kind)
    })

    it('a 429 waits as long as Retry-After says, on the read and on the write', async () => {
      const limited = () => wooError(429, 'too_many_requests', { 'retry-after': '9' })
      for (const ctx of [contextAnswering(limited), contextAnswering((method) => (method === 'GET' ? pending() : limited()))]) {
        const error = await updateOrderStatus(ctx, input).catch((caught: unknown) => caught)
        expect(classifyConnectorError(error)).toMatchObject({ kind: 'rate_limited', retryAfterMs: 9000 })
      }
    })
  })
})

describe('orders.updateStatus against the recorded shop', () => {
  const update = createWooCommerceConnector().capabilities['orders.updateStatus']!
  const read = (id: number) => `GET orders/${id}?_fields=id,status`
  const write = (id: number) => `PUT orders/${id}?_fields=id,status`

  it(
    'moves an order forward for each phase, once, and leaves alone what WooCommerce closed',
    () =>
      withOrdersScenario('orders-update-status', async (scenario) => {
        const ctx = scenario.context()
        const call = async (id: number | string, phase: OrderPhase): Promise<string[]> => {
          const before = scenario.requests.length
          await update(ctx, { orderExternalId: String(id), phase })
          return scenario.requests.slice(before)
        }

        // 33 is pending: taken up, then shipped; each step is done once however often it is asked for.
        expect(await call(33, 'new')).toEqual([])
        expect(await call(33, 'processing')).toEqual([read(33), write(33)])
        expect(await call(33, 'processing')).toEqual([read(33)])
        expect(await call(33, 'shipped')).toEqual([read(33), write(33)])
        expect(await call(33, 'shipped')).toEqual([read(33)])
        // Completed: not cancelled afterwards, and not taken up again.
        expect(await call(33, 'cancelled')).toEqual([read(33)])
        expect(await call(33, 'processing')).toEqual([read(33)])

        // 32 is on hold: cancelled, and then nothing moves it.
        expect(await call(32, 'cancelled')).toEqual([read(32), write(32)])
        expect(await call(32, 'cancelled')).toEqual([read(32)])
        expect(await call(32, 'shipped')).toEqual([read(32)])
        expect(await call(32, 'processing')).toEqual([read(32)])

        // 38 failed: closed for `shipped` and `cancelled`, taken up again for `processing`.
        expect(await call(38, 'shipped')).toEqual([read(38)])
        expect(await call(38, 'cancelled')).toEqual([read(38)])
        expect(await call(38, 'processing')).toEqual([read(38), write(38)])

        // 49 is put into a plugin's status (`packing`): not taken up, but shipped.
        await scenario.change((sandbox) => sandbox.put('orders/49', { status: 'packing' }))
        expect(await call(49, 'processing')).toEqual([read(49)])
        expect(await call(49, 'shipped')).toEqual([read(49), write(49)])

        // 36 is refunded and 48 completed: closed.
        expect(await call(36, 'shipped')).toEqual([read(36)])
        expect(await call(48, 'cancelled')).toEqual([read(48)])

        // 52 goes to the trash: a write would take it out again, so there is none.
        await scenario.change((sandbox) => sandbox.trash('orders/52'))
        for (const phase of ['processing', 'shipped', 'cancelled'] as const) expect(await call(52, phase)).toEqual([read(52)])
        await scenario.change(async (sandbox) => {
          expect((await sandbox.get('orders/52')).status).toBe('trash')
          // What the writes above left in the shop.
          for (const [id, status] of [[33, 'completed'], [32, 'cancelled'], [38, 'processing'], [49, 'completed']] as const) {
            expect((await sandbox.get(`orders/${id}`)).status, `order ${id}`).toBe(status)
          }
        })

        // The conformance kit's check C10 on the first Order of the feed (57, processing): every phase twice.
        const c10: string[] = []
        for (const phase of ORDER_PHASES) {
          for (let attempt = 0; attempt < 2; attempt++) c10.push(...(await call(57, phase)))
        }
        expect(c10).toEqual([read(57), read(57), read(57), write(57), read(57), read(57), read(57)])

        // No such order: 404 with WooCommerce's own code.
        const error = await update(ctx, { orderExternalId: '999999', phase: 'shipped' }).catch((caught: unknown) => caught)
        expect(classifyConnectorError(error)).toMatchObject({ kind: 'permanent', message: 'Order 999999 no longer exists in the shop' })
      }),
    RECORDING_TIMEOUT,
  )

  it(
    'a key that may only read fails for good at the write (401), saying it is read-only, and is not asked to sign in',
    () =>
      withOrdersScenario('orders-update-status-read-only', async (scenario) => {
        const error = await update(scenario.context('readOnly'), { orderExternalId: '53', phase: 'shipped' }).catch((caught: unknown) => caught)
        expect(classifyConnectorError(error)).toMatchObject({ kind: 'permanent', message: 'The WooCommerce API key is read-only: create a key with Read/Write permission' })
        // The write is refused like a wrong secret's would be; the read after it works, which tells them apart.
        expect(scenario.requests).toEqual([read(53), write(53), 'GET products?per_page=1&_fields=id'])
        await scenario.change(async (sandbox) => expect((await sandbox.get('orders/53')).status).toBe('processing'))
      }),
    RECORDING_TIMEOUT,
  )
})
