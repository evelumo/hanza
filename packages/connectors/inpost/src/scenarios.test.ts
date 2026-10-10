import { AuthExpiredError, PermanentError, RateLimitedError, TransientError, type ShipmentRequest } from '@hanza/connector-sdk'
import { isRecording, openCassette } from '@hanza/connector-sdk/testing'
import { describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import { inpostConfigSchema, type InpostConfig } from './config'
import { MAX_SEARCH_PAGES } from './earlier-shipment'
import { inpostConnector } from './index'
import { inpostMatch, inpostScrub } from './testing'

const TOKEN = 'scenario-token-00000000'
const { capabilities } = inpostConnector
const create = capabilities['shipments.create']!
const track = capabilities['shipments.track']!
const label = capabilities['shipments.label']!
const cancel = capabilities['shipments.cancel']!

interface Sent {
  method: string
  /** Path and query, without the time the search starts at. */
  target: string
  body: string | null
  authorization: string | null
}

/** A capability context around `fetch` that remembers what was sent and what was logged. */
function context(fetch: typeof globalThis.fetch, config: Partial<InpostConfig> = {}) {
  const sent: Sent[] = []
  const logs: Array<{ message: string; fields: Record<string, unknown> | undefined }> = []
  const watching: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    url.searchParams.delete('created_at_gteq')
    sent.push({ method: request.method, target: `${url.pathname}${url.search}`, body: typeof init?.body === 'string' ? init.body : null, authorization: request.headers.get('authorization') })
    return fetch(input, init)
  }
  const ctx = {
    app: {},
    config: inpostConfigSchema.parse({ environment: 'sandbox', organizationId: '12345', ...config }),
    credentials: { apiToken: TOKEN },
    fetch: watching,
    log: (message: string, fields?: Record<string, unknown>) => void logs.push({ message, fields }),
  }
  return { ctx, sent, logs, methods: () => sent.map((request) => request.method) }
}

/** A scenario cassette, written by hand from the documentation (see AGENTS.md). */
async function scenario(name: string, config: Partial<InpostConfig> = {}) {
  const cassette = await openCassette(new URL(`./fixtures/${name}.cassette.json`, import.meta.url), { scrub: inpostScrub, match: inpostMatch, secrets: [TOKEN] })
  return { cassette, ...context(cassette.fetch, config) }
}

const SEARCH = '/v1/organizations/12345/shipments?sort_by=created_at&sort_order=asc&per_page=100'
const searchPage = (page: number) => SEARCH.replace('&per_page', `&page=${page}&per_page`)
const byId = (ids: string[], page = 1) => `/v1/organizations/12345/shipments?id=${encodeURIComponent(ids.join(','))}&page=${page}&per_page=100`

/**
 * The cassettes hold placeholders where a recording had references (`scrubbed-N`, numbered by the recorder), and
 * ShipX's answers carry the same placeholder. So a scenario sends the placeholder as its reference.
 */
const lockerRequest = (reference: string, overrides: Partial<ShipmentRequest> = {}): ShipmentRequest => ({
  reference,
  requestedAt: '2026-10-10T09:00:00Z',
  service: 'inpost_locker_standard',
  receiver: { name: 'Jan Kowalski', company: null, email: 'jan.kowalski@example.com', phone: '111222333' },
  destination: { type: 'pickup_point', pointId: 'KRA010' },
  parcel: { preset: 'small' },
  cashOnDelivery: null,
  ...overrides,
})

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => Response.json(body, { status, headers })
const emptyList = () => json(200, { count: 0, page: 1, per_page: 100, items: [] })

// The scenarios are not recordings: with HANZA_RECORD_FIXTURES=1 they would overwrite their cassettes from the sandbox.
describe('InPost scenarios', { skip: isRecording() }, () => {
  describe('shipments.create', () => {
    it('returns the shipment of a create whose answer was lost, and posts nothing the second time', async () => {
      const { ctx, cassette, sent, methods } = await scenario('create-lost-answer')
      const request = lockerRequest('scrubbed-3', { parcel: { preset: 'medium' } })

      // The first call: InPost answers, and the job dies before the answer is stored.
      const lost = await create(ctx, request)
      expect(lost).toEqual({ outcome: 'created', externalId: '1600000201', status: 'pending', trackingNumber: null, carrierStatus: 'created' })
      expect(methods()).toEqual(['GET', 'POST'])

      // The repeat, minutes later: the label is bought by now.
      const repeated = await create(ctx, structuredClone(request))
      expect(repeated).toEqual({ outcome: 'created', externalId: '1600000201', status: 'ready', trackingNumber: '620999548227330124560025', carrierStatus: 'confirmed' })

      expect(methods()).toEqual(['GET', 'POST', 'GET'])
      expect(sent.map((request) => request.target)).toEqual([searchPage(1), '/v1/organizations/12345/shipments', searchPage(1)])
      expect(cassette.misses).toEqual([])
      expect(cassette.unused()).toEqual([])
    })

    it('searches since five minutes before the request was first made, oldest first', async () => {
      const { ctx, sent } = context(async (input, init) => {
        if (init?.method === 'POST') return json(201, { id: 9, status: 'created', tracking_number: null, reference: 'shp_search' })
        return new URL(new Request(input).url).searchParams.has('created_at_gteq') ? emptyList() : json(400, {})
      })
      const searched: string[] = []
      const watched = { ...ctx, fetch: ((input, init) => (searched.push(new Request(input, init).url), ctx.fetch(input, init))) as typeof fetch }
      await create(watched, lockerRequest('shp_search', { requestedAt: '2026-10-10T11:00:00+02:00' }))

      const search = new URL(searched[0]!)
      expect(search.origin).toBe('https://sandbox-api-shipx-pl.easypack24.net')
      expect(Object.fromEntries(search.searchParams)).toEqual({
        // 2026-10-10T08:55:00Z as a Unix time: the request was first made at 09:00 UTC.
        created_at_gteq: String(Date.UTC(2026, 9, 10, 8, 55, 0) / 1000),
        sort_by: 'created_at',
        sort_order: 'asc',
        page: '1',
        per_page: '100',
      })
      expect(sent.map((request) => request.method)).toEqual(['GET', 'POST'])
    })

    it('makes no request for a Shipment it can tell InPost will refuse', async () => {
      const { ctx, methods } = context(async () => json(500, {}))
      const request = lockerRequest('shp_no_email', { receiver: { name: 'Jan Kowalski', company: null, email: null, phone: '111222333' } })
      await expect(create(ctx, request)).resolves.toEqual({ outcome: 'rejected', code: 'receiver_email_missing' })
      expect(methods()).toEqual([])
    })

    it('reads every page of the search before it would post', async () => {
      const { ctx, cassette, sent } = await scenario('create-search-two-pages')
      const result = await create(ctx, lockerRequest('scrubbed-15'))
      expect(result).toMatchObject({ outcome: 'created', externalId: '1600000213', status: 'ready' })
      expect(sent.map((request) => `${request.method} ${request.target}`)).toEqual([`GET ${searchPage(1)}`, `GET ${searchPage(2)}`])
      expect(cassette.misses).toEqual([])
      expect(cassette.unused()).toEqual([])
    })

    it('stops at a page limit and posts nothing when the list never ends (a filter InPost ignored)', async () => {
      const page = (number: number) =>
        json(200, {
          count: 1_000_000,
          page: number,
          per_page: 100,
          items: Array.from({ length: 100 }, (_, index) => ({ id: number * 1000 + index, status: 'delivered', tracking_number: null, reference: `other-${number}-${index}` })),
        })
      const { ctx, methods } = context(async (input) => page(Number(new URL(new Request(input).url).searchParams.get('page'))))
      const error = await create(ctx, lockerRequest('shp_endless')).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(PermanentError)
      expect(methods()).toEqual(Array.from({ length: MAX_SEARCH_PAGES }, () => 'GET'))
    })

    it('posts nothing when the search fails', async () => {
      const { ctx, methods } = context(async () => json(500, {}))
      await expect(create(ctx, lockerRequest('shp_search_down'))).rejects.toBeInstanceOf(TransientError)
      expect(methods()).toEqual(['GET'])
    })

    it('rejects an unknown pickup point with the field and key InPost names', async () => {
      const { ctx, cassette, methods } = await scenario('create-unknown-target-point')
      const result = await create(ctx, lockerRequest('scrubbed-3', { destination: { type: 'pickup_point', pointId: 'XXX000X' } }))
      expect(result).toEqual({ outcome: 'rejected', code: 'target_point.does_not_exist' })
      expect(methods()).toEqual(['GET', 'POST'])
      expect(cassette.misses).toEqual([])
    })

    it('sends a courier Shipment with cash on delivery, insured for it, the amounts digit for digit', async () => {
      const { ctx, cassette, sent } = await scenario('create-courier-cod')
      const result = await create(ctx, {
        reference: 'scrubbed-7',
        requestedAt: '2026-10-10T09:00:00Z',
        service: 'inpost_courier_standard',
        receiver: { name: 'Maria Anna Wisniewska', company: 'Pracownia Przykladowa', email: 'maria.wisniewska@example.com', phone: '+48 111 222 555' },
        destination: {
          type: 'address',
          address: { name: 'Maria Anna Wisniewska', company: null, street: 'ul. Przykladowa 12/4', postalCode: '02-677', city: 'Warszawa', countryCode: 'PL', phone: null, taxId: null },
        },
        parcel: { lengthMm: 400, widthMm: 300, heightMm: 150, weightGrams: 2500 },
        cashOnDelivery: { amount: '129.90', currency: 'PLN' },
      })
      expect(result).toEqual({ outcome: 'created', externalId: '1600000221', status: 'pending', trackingNumber: null, carrierStatus: 'created' })
      expect(cassette.misses).toEqual([])
      const posted = sent.find((request) => request.method === 'POST')!
      expect(posted.body).toContain('"insurance":{"amount":129.90,"currency":"PLN"},"cod":{"amount":129.90,"currency":"PLN"}')
      expect(posted.body).toContain('"weight":{"amount":"2.5","unit":"kg"}')
      expect(posted.body).not.toContain('sender')
      expect(posted.authorization).toBe(`Bearer ${TOKEN}`)
    })

    it.each(['no_carriers', 'carrier_unavailable'])('rejects a request InPost refuses with %s', async (key) => {
      const { ctx } = context(async (_input, init) => (init?.method === 'POST' ? json(400, { status: 400, error: key, message: 'No carrier offers this service.', details: {} }) : emptyList()))
      await expect(create(ctx, lockerRequest('shp_refused'))).resolves.toEqual({ outcome: 'rejected', code: key })
    })

    it('fails the call, and rejects nothing, when InPost blocks the account', async () => {
      const { ctx } = context(async (_input, init) => (init?.method === 'POST' ? json(400, { status: 400, error: 'debt_collection', message: 'Unpaid invoices.', details: {} }) : emptyList()))
      const error = await create(ctx, lockerRequest('shp_blocked')).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(PermanentError)
      // InPost's key, which is this connector's own constant; never its message.
      expect((error as Error).message).toContain('debt_collection')
      expect((error as Error).message).not.toMatch(/invoice/i)
    })

    it.each([
      [401, AuthExpiredError],
      [403, PermanentError],
      [404, PermanentError],
      [429, RateLimitedError],
      [503, TransientError],
    ])('throws for a %i on the create itself, whatever its body says', async (status, expected) => {
      const { ctx } = context(async (_input, init) => (init?.method === 'POST' ? json(status, { status, error: 'validation_failed', details: { target_point: ['does_not_exist'] } }) : emptyList()))
      await expect(create(ctx, lockerRequest('shp_failing'))).rejects.toBeInstanceOf(expected)
    })

    it('asks again later, and posts nothing, when the earlier shipment is in a status it cannot translate', async () => {
      const { ctx, methods, logs } = context(async () =>
        json(200, { count: 1, page: 1, per_page: 100, items: [{ id: 77, status: 'sorted_by_drone', tracking_number: null, reference: 'shp_untranslated' }] }),
      )
      await expect(create(ctx, lockerRequest('shp_untranslated'))).rejects.toBeInstanceOf(TransientError)
      expect(methods()).toEqual(['GET'])
      expect(logs).toEqual([{ message: 'InPost reports a shipment status this connector does not know', fields: { externalId: '77', status: 'sorted_by_drone' } }])
    })
  })

  describe('shipments.track', () => {
    it('reports a purchase InPost will never finish as failed, with the reason', async () => {
      const { ctx, cassette, sent } = await scenario('track-failed-purchase')
      const states = await track(ctx, ['1600000301', '1600000302'])
      expect(states).toEqual([
        { externalId: '1600000301', status: 'failed', trackingNumber: null, carrierStatus: 'parcels_size_invalid' },
        { externalId: '1600000302', status: 'failed', trackingNumber: null, carrierStatus: 'transaction_failure' },
      ])
      expect(sent.map((request) => request.target)).toEqual([byId(['1600000301', '1600000302'])])
      expect(cassette.misses).toEqual([])
    })

    it('translates one shipment of every status group in one call, over the pages InPost returns', async () => {
      const { ctx, cassette, sent, logs } = await scenario('track-status-groups')
      const ids = Array.from({ length: 9 }, (_, index) => String(1600000401 + index))
      const states = await track(ctx, ids)

      expect(states.map((state) => [state.externalId, state.status, state.carrierStatus])).toEqual([
        ['1600000401', 'pending', 'offers_prepared'],
        ['1600000402', 'ready', 'confirmed'],
        ['1600000403', 'in_transit', 'adopted_at_sorting_center'],
        ['1600000404', 'awaiting_pickup', 'ready_to_pickup'],
        ['1600000405', 'delivery_problem', 'undelivered_wrong_address'],
        ['1600000406', 'delivered', 'delivered'],
        ['1600000407', 'returned', 'returned_to_sender'],
        ['1600000408', 'cancelled', 'canceled'],
      ])
      expect(states[0]!.trackingNumber).toBeNull()
      expect(states[1]!.trackingNumber).toBe('620999548227330124560402')

      // 1600000409 is in a status InPost added: left out, so it stays as it is, and the name is recorded.
      expect(logs).toEqual([{ message: 'InPost reports a shipment status this connector does not know', fields: { externalId: '1600000409', status: 'sorted_by_drone' } }])
      // 1600000499 came back although nobody asked for it.
      expect(states.map((state) => state.externalId)).not.toContain('1600000499')
      expect(sent.map((request) => request.target)).toEqual([byId(ids, 1), byId(ids, 2)])
      expect(cassette.misses).toEqual([])
      expect(cassette.unused()).toEqual([])
    })

    it('makes no request for no Shipments', async () => {
      const { ctx, methods } = context(async () => json(500, {}))
      await expect(track(ctx, [])).resolves.toEqual([])
      expect(methods()).toEqual([])
    })

    it('leaves out a Shipment InPost no longer lists', async () => {
      const { ctx } = context(async () => emptyList())
      await expect(track(ctx, ['1600000777'])).resolves.toEqual([])
    })

    it('stops when the id filter does not narrow the list', async () => {
      const { ctx, methods } = context(async (input) =>
        json(200, { count: 1_000_000, page: Number(new URL(new Request(input).url).searchParams.get('page')), per_page: 1, items: [{ id: 5, status: 'delivered', tracking_number: null, reference: null }] }),
      )
      await expect(track(ctx, ['1600000777'])).rejects.toBeInstanceOf(PermanentError)
      expect(methods().length).toBeLessThanOrEqual(10)
    })
  })

  describe('shipments.label', () => {
    it('fails as transient while InPost has not bought the label, and asks for the configured size', async () => {
      const { ctx, cassette, sent } = await scenario('label-too-early', { labelType: 'normal' })
      await expect(label(ctx, { externalId: '1600000501' })).rejects.toBeInstanceOf(TransientError)
      expect(sent.map((request) => request.target)).toEqual(['/v1/shipments/1600000501/label?format=pdf&type=normal'])
      expect(cassette.misses).toEqual([])
    })

    it('returns the file with the content type InPost names, or PDF when it names none', async () => {
      const bytes = new TextEncoder().encode('%PDF-1.4 label')
      const named = context(async () => new Response(bytes, { headers: { 'content-type': 'Application/PDF; charset=binary' } }))
      await expect(label(named.ctx, { externalId: '1' })).resolves.toEqual({ contentType: 'application/pdf', data: bytes })
      const unnamed = context(async () => new Response(new Blob([bytes])))
      await expect(label(unnamed.ctx, { externalId: '1' })).resolves.toEqual({ contentType: 'application/pdf', data: bytes })
    })

    it('never returns an error body or an empty file as a Label', async () => {
      const empty = context(async () => new Response(null, { status: 200, headers: { 'content-type': 'application/pdf' } }))
      await expect(label(empty.ctx, { externalId: '1' })).rejects.toBeInstanceOf(TransientError)
      const wrong = context(async () => json(200, { status: 200, error: 'label_generation_failed' }))
      await expect(label(wrong.ctx, { externalId: '1' })).rejects.toBeInstanceOf(PermanentError)
      const gone = context(async () => json(404, { status: 404, error: 'resource_not_found', details: {} }))
      await expect(label(gone.ctx, { externalId: '1' })).rejects.toBeInstanceOf(PermanentError)
    })
  })

  describe('shipments.cancel', () => {
    it('cancels before the purchase, and again when the first answer was lost', async () => {
      const { ctx, cassette, methods } = await scenario('cancel-in-time')
      await expect(cancel(ctx, { externalId: '1600000601' })).resolves.toEqual({ outcome: 'cancelled' })
      // The repeat: InPost no longer has the shipment (404).
      await expect(cancel(ctx, { externalId: '1600000601' })).resolves.toEqual({ outcome: 'cancelled' })
      expect(methods()).toEqual(['DELETE', 'DELETE'])
      expect(cassette.misses).toEqual([])
      expect(cassette.unused()).toEqual([])
    })

    it('is refused as too late once the label is bought', async () => {
      const { ctx, cassette, sent } = await scenario('cancel-too-late')
      await expect(cancel(ctx, { externalId: '1600000602' })).resolves.toEqual({ outcome: 'refused', code: 'too_late' })
      expect(sent.map((request) => `${request.method} ${request.target}`)).toEqual(['DELETE /v1/shipments/1600000602', `GET ${byId(['1600000602'])}`])
      expect(cassette.misses).toEqual([])
    })

    it('is cancelled, not refused, when InPost still lists the shipment as cancelled', async () => {
      const { ctx, cassette } = await scenario('cancel-already-cancelled')
      await expect(cancel(ctx, { externalId: '1600000603' })).resolves.toEqual({ outcome: 'cancelled' })
      expect(cassette.misses).toEqual([])
    })

    it('throws for a failure of the call', async () => {
      const { ctx } = context(async () => json(500, {}))
      await expect(cancel(ctx, { externalId: '1' })).rejects.toBeInstanceOf(TransientError)
    })
  })

  describe('failures of the call', () => {
    const failing = async (externalId: string) => {
      const { ctx } = await scenario('errors')
      return track(ctx, [externalId]).catch((caught: unknown) => caught)
    }

    it('asks for sign-in on a 401', async () => {
      expect(await failing('1600000901')).toBeInstanceOf(AuthExpiredError)
    })

    it('fails as permanent on a 403 and points at the Organization ID setting', async () => {
      const error = (await failing('1600000902')) as Error
      expect(error).toBeInstanceOf(PermanentError)
      expect(error.message).toContain('Organization ID')
      // Neither the token nor anything of the answer.
      expect(error.message).not.toContain(TOKEN)
      expect(error.message).not.toMatch(/access_forbidden|denied/)
    })

    it('fails as permanent on a 404 for the organization, with the same pointer', async () => {
      const error = (await failing('1600000903')) as Error
      expect(error).toBeInstanceOf(PermanentError)
      expect(error.message).toContain('Organization ID')
    })

    it('waits as long as a 429 says', async () => {
      const error = await failing('1600000904')
      expect(error).toBeInstanceOf(RateLimitedError)
      expect((error as RateLimitedError).retryAfterMs).toBe(7000)
    })

    it('retries a 500', async () => {
      expect(await failing('1600000905')).toBeInstanceOf(TransientError)
    })

    it('asks for sign-in on a 403 that says the token is not accepted', async () => {
      const { ctx } = context(async () => new Response(null, { status: 403, headers: { 'www-authenticate': 'Bearer realm="Doorkeeper", error="invalid_token"' } }))
      await expect(track(ctx, ['1'])).rejects.toBeInstanceOf(AuthExpiredError)
    })

    it('lets an error of the core through as it is', async () => {
      const limited = new RateLimitedError('no budget left', { retryAfterMs: 1500 })
      const { ctx } = context(async () => {
        throw limited
      })
      await expect(track(ctx, ['1'])).rejects.toBe(limited)
    })

    it('wraps a network failure as transient', async () => {
      const { ctx } = context(async () => {
        throw new TypeError('fetch failed')
      })
      const error = await track(ctx, ['1']).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(TransientError)
      expect((error as Error).cause).toBeInstanceOf(TypeError)
    })

    it('fails as permanent, naming only paths, on an answer of another shape', async () => {
      const { ctx } = context(async () => json(200, { count: 1, page: 1, per_page: 100, items: [{ id: 5, status: 7, reference: 'Jan Kowalski' }] }))
      const error = (await track(ctx, ['5']).catch((caught: unknown) => caught)) as Error
      expect(error).toBeInstanceOf(PermanentError)
      expect(error.cause).toBeInstanceOf(ZodError)
      expect(error.message).toContain('items.0.status')
      expect(error.message).not.toContain('Kowalski')
    })
  })
})
