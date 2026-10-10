import { AuthExpiredError, PermanentError, RateLimitedError, TransientError, type ShipmentRequest } from '@hanza/connector-sdk'
import { isRecording, openCassette } from '@hanza/connector-sdk/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ZodError } from 'zod'
import { MAX_LABEL_BYTES } from './capabilities/shipments-label'
import { inpostConfigSchema, type InpostConfig } from './config'
import { MAX_ID_LISTS } from './client'
import { findEarlierShipment, MAX_SEARCH_PAGES } from './earlier-shipment'
import { inpostConnector } from './index'
import { inpostMatch, inpostScrub } from './testing'

const TOKEN = 'scenario-token-00000000'
const { capabilities } = inpostConnector
const create = capabilities['shipments.create']!
const track = capabilities['shipments.track']!
const label = capabilities['shipments.label']!

interface Sent {
  method: string
  host: string
  /** Path and query, without the time the search starts at. */
  target: string
  body: string | null
  authorization: string | null
  redirect: RequestRedirect | undefined
}

/** A capability context around `fetch` that remembers what was sent and what was logged. */
function context(fetch: typeof globalThis.fetch, config: Partial<InpostConfig> = {}) {
  const sent: Sent[] = []
  const logs: Array<{ message: string; fields: Record<string, unknown> | undefined }> = []
  const watching: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    url.searchParams.delete('created_at_gteq')
    sent.push({
      method: request.method,
      host: url.host,
      target: `${url.pathname}${url.search}`,
      body: typeof init?.body === 'string' ? init.body : null,
      authorization: request.headers.get('authorization'),
      redirect: init?.redirect,
    })
    return fetch(input, init)
  }
  const ctx = {
    app: {},
    config: inpostConfigSchema.parse({ environment: 'sandbox', organizationId: '12345', ...config }),
    credentials: { apiToken: TOKEN },
    fetch: watching,
    log: (message: string, fields?: Record<string, unknown>) => void logs.push({ message, fields }),
  }
  return { ctx, sent, logs, methods: () => sent.map((request) => request.method), requests: () => sent.map((request) => `${request.method} ${request.target}`) }
}

/**
 * A scenario cassette: written by hand, in the shapes the sandbox answered on 2026-10-10 where it answered at all
 * (see AGENTS.md, "Fixtures").
 */
async function scenario(name: string, config: Partial<InpostConfig> = {}) {
  const cassette = await openCassette(new URL(`./fixtures/${name}.cassette.json`, import.meta.url), { scrub: inpostScrub, match: inpostMatch, secrets: [TOKEN] })
  return { cassette, ...context(cassette.fetch, config) }
}

const CREATE = '/v1/organizations/12345/shipments'
const searchPage = (page: number) => `${CREATE}?sort_by=created_at&sort_order=asc&page=${page}&per_page=100`
const byId = (ids: string[], page = 1) => `${CREATE}?id=${encodeURIComponent(ids.join(','))}&page=${page}&per_page=100`

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
const item = (id: number | string, overrides: Record<string, unknown> = {}) => ({ id, status: 'delivered', tracking_number: null, reference: `other-${id}`, ...overrides })
const list = (items: unknown[], count = items.length, headers: Record<string, string> = {}) => json(200, { count, page: 1, per_page: 100, items }, headers)
const emptyList = () => list([])
const pageOf = (input: RequestInfo | URL) => Number(new URL(new Request(input).url).searchParams.get('page'))
const isPost = (init: RequestInit | undefined) => init?.method === 'POST'
/** Answers the search with an empty list and the create with `answer`. */
const posting = (answer: () => Response) => context(async (_input, init) => (isPost(init) ? answer() : emptyList()))
const caught = (promise: Promise<unknown>) => promise.then(() => null).catch((error: unknown) => error as Error)

// The scenarios are not recordings: with HANZA_RECORD_FIXTURES=1 they would overwrite their cassettes from the sandbox.
describe('InPost scenarios', { skip: isRecording() }, () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  describe('shipments.create', () => {
    it('returns the shipment of a create whose answer was lost, and posts nothing the second time', async () => {
      const { ctx, cassette, requests } = await scenario('create-lost-answer')
      const request = lockerRequest('scrubbed-3', { parcel: { preset: 'medium' } })

      // The first call: InPost answers, and the job dies before the answer is stored.
      const lost = await create(ctx, request)
      expect(lost).toEqual({ outcome: 'created', externalId: '1600000201', status: 'pending', trackingNumber: null, carrierStatus: 'created' })

      // The repeat, minutes later: the label is bought by now.
      const repeated = await create(ctx, structuredClone(request))
      expect(repeated).toEqual({ outcome: 'created', externalId: '1600000201', status: 'ready', trackingNumber: '620999548227330124500201', carrierStatus: 'confirmed' })

      expect(requests()).toEqual([`GET ${searchPage(1)}`, `POST ${CREATE}`, `GET ${searchPage(1)}`])
      expect(cassette.misses).toEqual([])
      expect(cassette.unused()).toEqual([])
    })

    it('finds the shipment once the listing has caught up with the create, and posts once in all', async () => {
      const { ctx, cassette, methods } = await scenario('create-list-lag')
      const request = lockerRequest('scrubbed-3')

      const first = await create(ctx, request)
      expect(first).toMatchObject({ outcome: 'created', externalId: '1600000206' })

      // What the sandbox showed: for up to 5.4 s after the POST the listing does not have the shipment. A create
      // repeated now would post a second parcel, which is why the core waits 5 minutes before it repeats one.
      await expect(findEarlierShipment(ctx, request)).resolves.toBeNull()

      const repeated = await create(ctx, structuredClone(request))
      expect(repeated).toEqual({ outcome: 'created', externalId: '1600000206', status: 'pending', trackingNumber: null, carrierStatus: 'offer_selected' })
      expect(methods()).toEqual(['GET', 'POST', 'GET', 'GET'])
      expect(cassette.misses).toEqual([])
      expect(cassette.unused()).toEqual([])
    })

    it('searches since 15 minutes before the request was first made, oldest first, a hundred to a page', async () => {
      const searched: string[] = []
      const { ctx, methods } = context(async (input, init) => {
        if (isPost(init)) return json(201, item(9, { status: 'created', reference: 'shp_search' }))
        searched.push(new Request(input).url)
        return emptyList()
      })
      await create(ctx, lockerRequest('shp_search', { requestedAt: '2026-10-10T11:00:00+02:00' }))

      const search = new URL(searched[0]!)
      expect(search.origin).toBe('https://sandbox-api-shipx-pl.easypack24.net')
      expect(Object.fromEntries(search.searchParams)).toEqual({
        // 2026-10-10T08:45:00Z as a Unix time: the request was first made at 09:00 UTC.
        created_at_gteq: String(Date.UTC(2026, 9, 10, 8, 45, 0) / 1000),
        sort_by: 'created_at',
        sort_order: 'asc',
        page: '1',
        per_page: '100',
      })
      expect(methods()).toEqual(['GET', 'POST'])
    })

    it('makes no request for a Shipment it can tell InPost will refuse', async () => {
      const { ctx, methods } = context(async () => json(500, {}))
      const request = lockerRequest('shp_no_email', { receiver: { name: 'Jan Kowalski', company: null, email: null, phone: '111222333' } })
      await expect(create(ctx, request)).resolves.toEqual({ outcome: 'rejected', code: 'receiver_email_missing' })
      expect(methods()).toEqual([])
    })

    describe('the search before the POST', () => {
      const full = (page: number) => Array.from({ length: 100 }, (_, index) => item(page * 1000 + index))

      it('reads every page, and finds the earlier shipment on the last one', async () => {
        const { ctx, requests } = context(async (input) => (pageOf(input) === 1 ? list(full(1), 101) : list([item(77, { status: 'confirmed', tracking_number: '620999548227330124500077', reference: 'shp_page_two' })], 101)))
        await expect(create(ctx, lockerRequest('shp_page_two'))).resolves.toMatchObject({ outcome: 'created', externalId: '77', status: 'ready' })
        expect(requests()).toEqual([`GET ${searchPage(1)}`, `GET ${searchPage(2)}`])
      })

      it('posts only after it has seen as many shipments as InPost counts', async () => {
        const { ctx, requests } = context(async (input, init) => {
          if (isPost(init)) return json(201, item(9, { status: 'created', reference: 'shp_after_two_pages' }))
          return pageOf(input) === 1 ? list(full(1), 101) : list([item(5)], 101)
        })
        await expect(create(ctx, lockerRequest('shp_after_two_pages'))).resolves.toMatchObject({ outcome: 'created', externalId: '9' })
        expect(requests()).toEqual([`GET ${searchPage(1)}`, `GET ${searchPage(2)}`, `POST ${CREATE}`])
      })

      it('posts nothing when InPost counts more shipments than it lists', async () => {
        const { ctx, cassette, methods } = await scenario('create-search-inconsistent')
        await expect(create(ctx, lockerRequest('shp_wanted'))).rejects.toBeInstanceOf(TransientError)
        expect(methods()).toEqual(['GET'])
        expect(cassette.misses).toEqual([])
      })

      it.each([
        ['a short page under a higher count', () => list(Array.from({ length: 25 }, (_, index) => item(index + 1)), 60)],
        ['an empty page under a count', () => list([], 60)],
        // The echoed page size is whatever was asked, so it cannot excuse a short page either.
        ['a short page that claims to be full', () => json(200, { count: 60, page: 1, per_page: 25, items: Array.from({ length: 25 }, (_, index) => item(index + 1)) })],
      ])('asks again later, and posts nothing, on %s', async (_what, answer) => {
        const { ctx, methods } = context(async () => answer())
        await expect(create(ctx, lockerRequest('shp_inconsistent'))).rejects.toBeInstanceOf(TransientError)
        expect(methods()).toEqual(['GET'])
      })

      it('posts nothing when a page repeats the one before', async () => {
        const { ctx, methods } = context(async () => list(full(1), 250))
        await expect(create(ctx, lockerRequest('shp_repeating'))).rejects.toBeInstanceOf(TransientError)
        expect(methods()).toEqual(['GET', 'GET'])
      })

      it('posts nothing when the count drops between two pages: a shipment may have slipped between them', async () => {
        // One of the first hundred was cancelled after page 1 was read; InPost lists cancelled shipments nowhere.
        const { ctx, methods } = context(async (input) => (pageOf(input) === 1 ? list(full(1), 150) : list(full(2).slice(0, 49), 149)))
        await expect(create(ctx, lockerRequest('shp_slipped'))).rejects.toBeInstanceOf(TransientError)
        expect(methods()).toEqual(['GET', 'GET'])
      })

      it('stops at a page limit and posts nothing when the list never ends (a filter InPost ignored)', async () => {
        const { ctx, methods } = context(async (input) => list(full(pageOf(input)), 1_000_000))
        await expect(create(ctx, lockerRequest('shp_endless'))).rejects.toBeInstanceOf(PermanentError)
        expect(methods()).toEqual(Array.from({ length: MAX_SEARCH_PAGES }, () => 'GET'))
      })

      it('posts nothing when the search fails', async () => {
        const { ctx, methods } = context(async () => json(500, {}))
        await expect(create(ctx, lockerRequest('shp_search_down'))).rejects.toBeInstanceOf(TransientError)
        expect(methods()).toEqual(['GET'])
      })

      it('refuses a shipment id that is not digits, wherever InPost puts it', async () => {
        const listed = context(async () => list([item('../label', { reference: 'shp_bad_id' })]))
        const error = await caught(create(listed.ctx, lockerRequest('shp_bad_id')))
        expect(error).toBeInstanceOf(PermanentError)
        expect(error?.message).toContain('items.0.id')
        expect(listed.methods()).toEqual(['GET'])

        const posted = posting(() => json(201, item('..', { status: 'created', reference: 'shp_bad_id' })))
        await expect(create(posted.ctx, lockerRequest('shp_bad_id'))).rejects.toBeInstanceOf(PermanentError)
      })
    })

    describe('the two clocks', () => {
      const at = (iso: string) => vi.useFakeTimers({ toFake: ['Date'], now: new Date(iso) })

      it('posts nothing when this server and InPost disagree about the time', async () => {
        // The cassette's answer is dated 08:50:30 GMT, and this server believes it is ten minutes later: inside the
        // margin of the search, and still refused, because nothing says the next skew will be.
        at('2026-10-10T09:00:31Z')
        const { ctx, cassette, methods } = await scenario('create-clock-skew')
        const error = await caught(create(ctx, lockerRequest('shp_clock')))
        expect(error).toBeInstanceOf(PermanentError)
        expect(error?.message).toMatch(/clock of this Hanza server is 10 minutes away/)
        expect(methods()).toEqual(['GET'])
        expect(cassette.misses).toEqual([])
      })

      it.each([
        ['six minutes ahead of InPost', '2026-10-10T09:06:01Z', false],
        ['six minutes behind InPost', '2026-10-10T08:53:59Z', false],
        ['four minutes ahead of InPost', '2026-10-10T09:04:00Z', true],
        ['four minutes behind InPost', '2026-10-10T08:56:00Z', true],
      ])('with this server %s, posting is %s', async (_what, now, posts) => {
        at(now)
        const { ctx, methods } = context(async (_input, init) =>
          isPost(init) ? json(201, item(9, { status: 'created', reference: 'shp_clock' })) : list([], 0, { date: 'Sat, 10 Oct 2026 09:00:00 GMT' }),
        )
        const result = await caught(create(ctx, lockerRequest('shp_clock')))
        if (posts) expect(result).toBeNull()
        else expect(result).toBeInstanceOf(PermanentError)
        expect(methods()).toEqual(posts ? ['GET', 'POST'] : ['GET'])
      })

      it('still returns an earlier shipment it found, whatever the clocks say', async () => {
        at('2026-10-10T12:00:00Z')
        const { ctx, methods } = context(async () => list([item(31, { status: 'confirmed', tracking_number: '620999548227330124500031', reference: 'shp_clock' })], 1, { date: 'Sat, 10 Oct 2026 09:00:00 GMT' }))
        await expect(create(ctx, lockerRequest('shp_clock'))).resolves.toMatchObject({ outcome: 'created', externalId: '31', status: 'ready' })
        expect(methods()).toEqual(['GET'])
      })

      it('relies on the margin alone when the answer carries no date (a replayed cassette keeps none)', async () => {
        at('2031-01-01T00:00:00Z')
        const { ctx, methods } = posting(() => json(201, item(9, { status: 'created', reference: 'shp_clock' })))
        await expect(create(ctx, lockerRequest('shp_clock'))).resolves.toMatchObject({ outcome: 'created' })
        expect(methods()).toEqual(['GET', 'POST'])
      })
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

    // Hand-written: the sandbox account has no bank account, so InPost never got as far as judging the insurance.
    it('insures a locker Shipment with cash on delivery for the same amount', async () => {
      const { ctx, cassette, sent } = await scenario('create-locker-cod')
      const result = await create(ctx, lockerRequest('scrubbed-3', { cashOnDelivery: { amount: '49.50', currency: 'PLN' } }))
      expect(result).toEqual({ outcome: 'created', externalId: '1600000226', status: 'pending', trackingNumber: null, carrierStatus: 'created' })
      expect(sent.find((request) => request.method === 'POST')!.body).toContain('"insurance":{"amount":49.50,"currency":"PLN"},"cod":{"amount":49.50,"currency":"PLN"}')
      expect(cassette.misses).toEqual([])
    })

    it.each([
      ['carrier_unavailable', { status: 400, error: 'carrier_unavailable', message: 'No carrier offers this service.', details: {} }, 'carrier_unavailable'],
      // Word for word what the sandbox answers `inpost_courier_standard` on an account without a courier contract.
      ['missing_trucker_id', { status: 400, error: 'missing_trucker_id', message: 'trucker_ID_is_not_set_for_organization', details: null }, 'missing_trucker_id'],
      ['the same as the FAQ spells it', { status: 400, error: 'trucker_ID_is_not_set_for_organization', details: {} }, 'missing_trucker_id'],
    ])('rejects a request for a service the account does not have (%s): another service would work', async (_what, body, code) => {
      const { ctx, methods, logs } = posting(() => json(400, body))
      await expect(create(ctx, lockerRequest('shp_refused'))).resolves.toEqual({ outcome: 'rejected', code })
      // Refused by InPost, so nothing was made, and nothing is tried again.
      expect(methods()).toEqual(['GET', 'POST'])
      expect(logs).toEqual([])
    })

    it.each([
      ['debt_collection', 400, { status: 400, error: 'debt_collection', message: 'Unpaid invoices.', details: {} }, 'debt_collection'],
      ['debt_collection', 422, { status: 422, error: 'debt_collection', message: 'Unpaid invoices.', details: {} }, 'debt_collection'],
      ['no_carriers', 400, { status: 400, error: 'no_carriers', message: 'Unpaid invoices.', details: {} }, 'no_carriers'],
    ])('fails the call, and rejects nothing, when InPost refuses the whole account with %s (%i)', async (_key, status, body, named) => {
      const { ctx, methods } = posting(() => json(status, body))
      const error = await caught(create(ctx, lockerRequest('shp_blocked')))
      expect(error).toBeInstanceOf(PermanentError)
      // The key as this connector's own constant; never InPost's message.
      expect(error?.message).toContain(`(${named})`)
      expect(error?.message).not.toMatch(/invoice/i)
      expect(methods()).toEqual(['GET', 'POST'])
    })

    it.each([
      ['a key nobody has seen', 'quota_exceeded', 'quota_exceeded'],
      ['a word that could be a name', 'Kowalski', 'unreadable'],
      ['a sentence', 'Insurance should be equal or higher than COD', 'unreadable'],
    ])('fails the call for %s instead of failing the Shipment for good, and stores none of it', async (_what, key, logged) => {
      const { ctx, logs } = posting(() => json(400, { status: 400, error: key, message: 'Jan Kowalski, ul. Przykladowa 12/4', details: {} }))
      const error = await caught(create(ctx, lockerRequest('shp_unknown_key')))
      expect(error).toBeInstanceOf(PermanentError)
      expect(error?.message).not.toContain(key)
      expect(error?.message).not.toMatch(/Kowalski|Przykladowa/)
      expect(logs).toEqual([{ message: 'InPost refused a new shipment with an error key this connector does not know', fields: { status: 400, key: logged } }])
    })

    it('fails the call for a 4xx whose body is not a ShipX error', async () => {
      const { ctx } = posting(() => new Response('<html>Bad Request</html>', { status: 400, headers: { 'content-type': 'text/html' } }))
      await expect(create(ctx, lockerRequest('shp_html'))).rejects.toBeInstanceOf(PermanentError)
    })

    describe.each([
      ['the search', (init: RequestInit | undefined) => !isPost(init), ['GET']],
      ['the POST', isPost, ['GET', 'POST']],
    ])('a failure of %s', (_where, fails, expected) => {
      it.each([
        [401, AuthExpiredError],
        [403, PermanentError],
        [404, PermanentError],
        [408, TransientError],
        [429, RateLimitedError],
        [500, TransientError],
        [503, TransientError],
      ])('throws for a %i, whatever its body says, and never rejects the Shipment', async (status, expectedError) => {
        const refusal = { status, error: 'validation_failed', details: { custom_attributes: [{ target_point: ['does_not_exist'] }] } }
        const { ctx, methods } = context(async (_input, init) => (fails(init) ? json(status, refusal) : emptyList()))
        await expect(create(ctx, lockerRequest('shp_failing'))).rejects.toBeInstanceOf(expectedError)
        expect(methods()).toEqual(expected)
      })

      it('does not ask for sign-in on a bare 403', async () => {
        const { ctx } = context(async (_input, init) => (fails(init) ? new Response(null, { status: 403, statusText: 'Forbidden' }) : emptyList()))
        const error = await caught(create(ctx, lockerRequest('shp_forbidden')))
        expect(error).toBeInstanceOf(PermanentError)
        expect(error).not.toBeInstanceOf(AuthExpiredError)
      })
    })

    // The conformance kit cannot get here: its 401, 403 and 500 are answered to the search, which comes first.
    describe('the POST itself fails, after a search that found nothing', () => {
      const timeout = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      const failures: Array<[string, () => Response | Promise<Response>, new (...args: never[]) => Error, string]> = [
        ['a 401', () => json(401, { status: 401, error: 'token_invalid', message: 'Token is missing or invalid.', details: {} }), AuthExpiredError, 'auth_expired'],
        ['a 403', () => json(403, { status: 403, error: 'forbidden', message: 'Access forbidden for this token.', details: {} }), PermanentError, 'permanent'],
        ['a 500', () => json(500, { status: 500, error: 'internal_server_error', message: 'Unexpected error occurred.', details: {} }), TransientError, 'transient'],
        ['a timeout', () => Promise.reject(timeout()), TransientError, 'transient'],
      ]

      it.each(failures)('throws for %s: the Shipment is not rejected, and nothing is posted again', async (_what, answer, expected, kind) => {
        const { ctx, requests } = posting(() => answer() as Response)
        const outcome = await create(ctx, lockerRequest('shp_post_fails')).then(
          (result) => ({ result, error: null }),
          (error: unknown) => ({ result: null, error }),
        )
        expect(outcome.result).toBeNull()
        expect(outcome.error).toBeInstanceOf(expected)
        expect((outcome.error as { kind: string }).kind).toBe(kind)
        // One search, one POST: the connector does not try the POST a second time by itself.
        expect(requests()).toEqual([`GET ${searchPage(1)}`, `POST ${CREATE}`])
      })

      it.each(failures)('after %s, the repeat searches again and posts once more only because InPost made nothing', async (_what, answer) => {
        let posts = 0
        const { ctx, methods } = context(async (_input, init) => {
          if (!isPost(init)) return emptyList()
          return ++posts === 1 ? answer() : json(201, item(9, { status: 'created', reference: 'shp_post_fails' }))
        })
        await expect(create(ctx, lockerRequest('shp_post_fails'))).rejects.toBeInstanceOf(Error)
        await expect(create(ctx, lockerRequest('shp_post_fails'))).resolves.toMatchObject({ outcome: 'created', externalId: '9' })
        expect(methods()).toEqual(['GET', 'POST', 'GET', 'POST'])
      })

      it('after a POST that timed out although InPost made the shipment, the repeat finds it and posts nothing', async () => {
        // The answer was lost, not the request. By the time the core repeats (5 minutes), the listing has it.
        let made = false
        const { ctx, methods } = context(async (_input, init) => {
          if (isPost(init)) {
            made = true
            throw timeout()
          }
          return made ? list([item(9, { status: 'confirmed', tracking_number: '620999548227330124500009', reference: 'shp_post_fails' })]) : emptyList()
        })
        await expect(create(ctx, lockerRequest('shp_post_fails'))).rejects.toBeInstanceOf(TransientError)
        await expect(create(ctx, lockerRequest('shp_post_fails'))).resolves.toMatchObject({ outcome: 'created', externalId: '9', status: 'ready' })
        expect(methods()).toEqual(['GET', 'POST', 'GET'])
      })
    })

    describe('a repeat that finds the earlier shipment in a status it cannot translate', () => {
      it('answers with the least that is true, and posts nothing', async () => {
        const { ctx, cassette, methods, logs } = await scenario('create-untranslatable-status')
        const result = await create(ctx, lockerRequest('scrubbed-1'))
        // InPost has bought the label (there is a tracking number); where the parcel is, nobody guesses.
        expect(result).toEqual({ outcome: 'created', externalId: '1600000231', status: 'ready', trackingNumber: '620999548227330124500231', carrierStatus: 'sorted_by_drone' })
        expect(methods()).toEqual(['GET'])
        expect(logs).toEqual([{ message: 'InPost reports a shipment status this connector does not know', fields: { externalId: '1600000231', status: 'sorted_by_drone' } }])
        expect(cassette.misses).toEqual([])
      })

      it.each([
        ['other', null, 'pending', 'other'],
        ['other', '620999548227330124500078', 'ready', 'other'],
        ['missing', '620999548227330124500078', 'ready', 'missing'],
        ['Sorted by a drone', null, 'pending', null],
      ])('reports %s (tracking number %s) as %s', async (status, trackingNumber, expected, carrierStatus) => {
        const { ctx, methods } = context(async () => list([item(78, { status, tracking_number: trackingNumber, reference: 'shp_untranslated' })]))
        await expect(create(ctx, lockerRequest('shp_untranslated'))).resolves.toEqual({ outcome: 'created', externalId: '78', status: expected, trackingNumber, carrierStatus })
        expect(methods()).toEqual(['GET'])
      })
    })

    describe('a redirect', () => {
      it('is not followed: the receiver is posted once, to InPost', async () => {
        const { ctx, cassette, sent, requests } = await scenario('create-redirect')
        const error = await caught(create(ctx, lockerRequest('scrubbed-3')))
        expect(error).toBeInstanceOf(PermanentError)
        expect(error?.message).toMatch(/redirect/)
        expect(error?.message).not.toContain('example.net')
        expect(requests()).toEqual([`GET ${searchPage(1)}`, `POST ${CREATE}`])
        expect(new Set(sent.map((request) => request.host))).toEqual(new Set(['sandbox-api-shipx-pl.easypack24.net']))
        expect(cassette.misses).toEqual([])
      })

      it('tells every request not to follow one', async () => {
        const { ctx, sent } = posting(() => json(201, item(9, { status: 'created', reference: 'shp_redirect' })))
        await create(ctx, lockerRequest('shp_redirect'))
        await track(ctx, ['9'])
        await label(ctx, { externalId: '9' }).catch(() => {})
        // The search and the POST, a track and a label.
        expect(sent.map((request) => request.method)).toEqual(['GET', 'POST', 'GET', 'GET'])
        expect(new Set(sent.map((request) => request.redirect))).toEqual(new Set(['error']))
      })

      it('fails as permanent when the transport refuses one, as Node does', async () => {
        const { ctx } = context(async () => {
          throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') })
        })
        await expect(create(ctx, lockerRequest('shp_redirect'))).rejects.toBeInstanceOf(PermanentError)
      })
    })
  })

  describe('shipments.track', () => {
    it('keeps a Shipment waiting while its offer can still be bought, and fails it only when none can', async () => {
      const { ctx, cassette, requests } = await scenario('track-failed-purchase')
      const ids = ['1600000301', '1600000302', '1600000303', '1600000304']
      const states = await track(ctx, ids)
      expect(states.sort((a, b) => a.externalId.localeCompare(b.externalId))).toEqual([
        // As the sandbox answered without funds: the offer stays `selected`, so a later payment could still buy it.
        { externalId: '1600000301', status: 'pending', trackingNumber: null, carrierStatus: 'debt_collection' },
        { externalId: '1600000302', status: 'pending', trackingNumber: null, carrierStatus: 'company_data_missing' },
        { externalId: '1600000303', status: 'failed', trackingNumber: null, carrierStatus: 'parcels_size_invalid' },
        { externalId: '1600000304', status: 'failed', trackingNumber: null, carrierStatus: 'offer_expired' },
      ])
      // The payment's details name the account's owner; nothing of them leaves the connector.
      expect(JSON.stringify(states)).not.toContain('example.com')
      expect(requests()).toEqual([`GET ${byId(ids)}`])
      expect(cassette.misses).toEqual([])
    })

    it('translates one shipment of every status group in one call, over the pages InPost returns', async () => {
      const { ctx, cassette, requests, logs } = await scenario('track-status-groups')
      const ids = Array.from({ length: 10 }, (_, index) => String(1600000401 + index))
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
      expect(states[1]!.trackingNumber).toBe('620999548227330124500402')

      // 1600000409 is in a status InPost added: left out, so it stays as it is, and the name is recorded.
      expect(logs).toEqual([{ message: 'InPost reports a shipment status this connector does not know', fields: { externalId: '1600000409', status: 'sorted_by_drone' } }])
      // 1600000499 came back although nobody asked for it; 1600000410 was asked for and is not InPost's.
      expect(requests()).toEqual([`GET ${byId(ids, 1)}`, `GET ${byId(ids, 2)}`])
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

    it('tracks a hundred Shipments when InPost pages below what was asked', async () => {
      const ids = Array.from({ length: 100 }, (_, index) => String(5000 + index))
      const { ctx, methods } = context(async (input) => {
        const page = pageOf(input)
        const items = ids.slice((page - 1) * 5, page * 5).map((id) => item(Number(id)))
        return json(200, { count: 100, page, per_page: 5, items })
      })
      const states = await track(ctx, ids)
      expect(states.map((state) => state.externalId)).toEqual(ids)
      expect(methods()).toHaveLength(20)
    })

    it('reads on only while a page brings something new', async () => {
      // What the sandbox did with an `id` filter: the whole list on the first page, part of it again on the next.
      const { ctx, methods } = context(async () => list([item(1), item(2), item(3)], 3))
      await expect(track(ctx, ['1', '2', '3', '4'])).resolves.toHaveLength(3)
      expect(methods()).toEqual(['GET'])

      const repeating = context(async () => list([item(1), item(2)], 4))
      await expect(track(repeating.ctx, ['1', '2', '3', '4'])).resolves.toHaveLength(2)
      expect(repeating.methods()).toEqual(['GET', 'GET'])
    })

    it('fails when InPost counts more shipments than ids were asked: its id filter was ignored', async () => {
      const { ctx, methods } = context(async (input) => json(200, { count: 1_000_000, page: pageOf(input), per_page: 100, items: [item(5)] }))
      await expect(track(ctx, ['1600000777'])).rejects.toBeInstanceOf(PermanentError)
      expect(methods()).toEqual(['GET'])
    })

    it('leaves out an id InPost does not have, and answers for the one beside it', async () => {
      // As on the sandbox: an id of ShipX's own form that the account does not have is simply not listed.
      const { ctx, cassette, requests, logs } = await scenario('track-unknown-id')
      const states = await track(ctx, ['1600000701', '999999999999'])
      expect(states).toEqual([{ externalId: '1600000701', status: 'ready', trackingNumber: '620999548227330124500701', carrierStatus: 'confirmed' }])
      expect(requests()).toEqual([`GET ${byId(['1600000701', '999999999999'])}`])
      expect(logs).toEqual([])
      expect(cassette.misses).toEqual([])
    })

    it('never asks for an id that is not of the form of InPost ids: one of them fails the list for all', async () => {
      // `0`, `00`, a word and a number near 2^63 were each answered 400 for the whole list on the sandbox.
      const foreign = ['0', '00', '014588072', '99999999999999999999', '9223372036854775807', '..', 'abc', '1,2', '-1', '1.5', ' 16000001', '']
      const { ctx, requests, logs } = context(async () => list([item(16000001)]))
      await expect(track(ctx, [...foreign.slice(0, 6), '16000001', ...foreign.slice(6)])).resolves.toMatchObject([{ externalId: '16000001' }])
      expect(requests()).toEqual([`GET ${byId(['16000001'])}`])
      expect(logs).toEqual([{ message: 'Shipments whose id is not an InPost shipment id were left out of tracking', fields: { count: foreign.length } }])

      const none = context(async () => json(500, {}))
      await expect(track(none.ctx, foreign)).resolves.toEqual([])
      expect(none.methods()).toEqual([])
    })

    describe('a list InPost refuses for one of its ids', () => {
      const echoing = (id: string) => json(400, { status: 400, error: 'validation_failed', message: `Shipment ${id} of Jan Kowalski does not exist`, details: { shipment: [`id_${id}_does_not_exist`] } })
      const idsOf = (input: RequestInfo | URL) => new URL(new Request(input).url).searchParams.get('id')!.split(',')

      it('asks again in halves, leaves that id out, and answers for the others', async () => {
        const { ctx, cassette, requests, logs } = await scenario('track-id-refused')
        const states = await track(ctx, ['1600000711', '1600000712', '1600000713'])
        expect(states.map((state) => [state.externalId, state.status])).toEqual([
          ['1600000713', 'awaiting_pickup'],
          ['1600000711', 'ready'],
        ])
        expect(requests()).toEqual([
          `GET ${byId(['1600000711', '1600000712', '1600000713'])}`,
          `GET ${byId(['1600000711', '1600000712'])}`,
          `GET ${byId(['1600000713'])}`,
          `GET ${byId(['1600000711'])}`,
          `GET ${byId(['1600000712'])}`,
        ])
        // How many, never which: the answer that names the id is not repeated anywhere.
        expect(logs).toEqual([{ message: 'InPost refused a list of shipment ids; the ids it would not take were left out of tracking', fields: { refused: 1, unanswered: 0 } }])
        expect(JSON.stringify([states, logs])).not.toContain('does_not_exist')
        expect(cassette.misses).toEqual([])
        expect(cassette.unused()).toEqual([])
      })

      it('finds one such id among a hundred in 15 lists', async () => {
        const ids = Array.from({ length: 100 }, (_, index) => String(7000 + index))
        const { ctx, methods, logs } = context(async (input) => {
          const asked = idsOf(input)
          return asked.includes('7042') ? echoing('7042') : list(asked.map((id) => item(Number(id))))
        })
        const states = await track(ctx, ids)
        expect(states.map((state) => state.externalId).sort()).toEqual(ids.filter((id) => id !== '7042'))
        expect(methods()).toHaveLength(15)
        expect(logs.map((entry) => entry.fields)).toEqual([{ refused: 1, unanswered: 0 }])
      })

      it('stops at a bound when InPost refuses every list, and repeats nothing of what it answered', async () => {
        const ids = Array.from({ length: 100 }, (_, index) => String(7000 + index))
        const { ctx, methods, logs } = context(async (input) => echoing(idsOf(input)[0]!))
        await expect(track(ctx, ids)).resolves.toEqual([])
        expect(methods()).toHaveLength(MAX_ID_LISTS)
        expect(logs).toHaveLength(1)
        expect(logs[0]!.fields).toEqual({ refused: 0, unanswered: expect.any(Number) })
        expect(JSON.stringify(logs)).not.toMatch(/does_not_exist|Kowalski|70\d\d/)
      })

      it('still fails the call for any other 400, and for a refusal that is not about the request', async () => {
        const other = context(async () => json(400, { status: 400, error: 'invalid_action', details: {} }))
        await expect(track(other.ctx, ['1', '2'])).rejects.toBeInstanceOf(PermanentError)
        expect(other.methods()).toEqual(['GET'])
        const forbidden = context(async () => json(403, { status: 403, error: 'validation_failed', details: {} }))
        await expect(track(forbidden.ctx, ['1', '2'])).rejects.toBeInstanceOf(PermanentError)
        expect(forbidden.methods()).toEqual(['GET'])
      })
    })
  })

  describe('shipments.label', () => {
    const pdfBytes = new TextEncoder().encode('%PDF-1.4 label')

    it('fails as transient while InPost has not bought the label', async () => {
      const { ctx, cassette, requests } = await scenario('label-too-early')
      await expect(label(ctx, { externalId: '1600000501' })).rejects.toBeInstanceOf(TransientError)
      expect(requests()).toEqual(['GET /v1/shipments/1600000501/label?format=pdf&type=A6'])
      expect(cassette.misses).toEqual([])
    })

    it('names no type for a normal label: without one InPost returns normal, and A6 for a courier shipment', async () => {
      const { ctx, requests } = context(async () => new Response(pdfBytes), { labelType: 'normal' })
      await label(ctx, { externalId: '1600000501' })
      expect(requests()).toEqual(['GET /v1/shipments/1600000501/label?format=pdf'])
    })

    it('returns a PDF as a PDF, whatever the header calls it', async () => {
      for (const contentType of ['Application/PDF; charset=binary', 'application/octet-stream', 'text/html']) {
        const { ctx } = context(async () => new Response(pdfBytes, { headers: { 'content-type': contentType } }))
        await expect(label(ctx, { externalId: '1' })).resolves.toEqual({ contentType: 'application/pdf', data: pdfBytes })
      }
      const unnamed = context(async () => new Response(new Blob([pdfBytes])))
      await expect(label(unnamed.ctx, { externalId: '1' })).resolves.toEqual({ contentType: 'application/pdf', data: pdfBytes })
    })

    it('does not take an error page answered with 200 for the Label, and asks again', async () => {
      const { ctx, cassette } = await scenario('label-not-pdf')
      await expect(label(ctx, { externalId: '1600000502' })).rejects.toBeInstanceOf(TransientError)
      const second = await label(ctx, { externalId: '1600000502' })
      expect(second.contentType).toBe('application/pdf')
      expect(new TextDecoder().decode(second.data.slice(0, 5))).toBe('%PDF-')
      expect(cassette.misses).toEqual([])
      expect(cassette.unused()).toEqual([])
    })

    it('never returns an error body or an empty file as a Label', async () => {
      const empty = context(async () => new Response(null, { status: 200, headers: { 'content-type': 'application/pdf' } }))
      await expect(label(empty.ctx, { externalId: '1' })).rejects.toBeInstanceOf(TransientError)
      const wrong = context(async () => json(200, { status: 200, error: 'label_generation_failed' }))
      await expect(label(wrong.ctx, { externalId: '1' })).rejects.toBeInstanceOf(TransientError)
      const named = context(async () => new Response('<html>503</html>', { headers: { 'content-type': 'application/pdf' } }))
      await expect(label(named.ctx, { externalId: '1' })).rejects.toBeInstanceOf(TransientError)
      const gone = context(async () => json(404, { status: 404, error: 'resource_not_found', details: {} }))
      await expect(label(gone.ctx, { externalId: '1' })).rejects.toBeInstanceOf(PermanentError)
    })

    it('does not read a file that says it is larger than a Label may be', async () => {
      let pulled = 0
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled++
          controller.enqueue(pdfBytes)
        },
      })
      const { ctx } = context(async () => new Response(body, { headers: { 'content-type': 'application/pdf', 'content-length': String(MAX_LABEL_BYTES + 1) } }))
      await expect(label(ctx, { externalId: '1' })).rejects.toBeInstanceOf(PermanentError)
      expect(pulled).toBeLessThanOrEqual(1)
    })

    it('stops reading a file that turns out larger than it said', async () => {
      const chunk = new Uint8Array(1024 * 1024).fill(0x20)
      chunk.set(pdfBytes)
      let pulled = 0
      let cancelled = false
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulled++
            controller.enqueue(chunk)
          },
          cancel() {
            cancelled = true
          },
        },
        { highWaterMark: 0 },
      )
      const { ctx } = context(async () => new Response(body, { headers: { 'content-type': 'application/pdf' } }))
      await expect(label(ctx, { externalId: '1' })).rejects.toBeInstanceOf(PermanentError)
      expect(cancelled).toBe(true)
      // 5 MB fit; the sixth megabyte is one too many, and nothing is read after it.
      expect(pulled).toBeLessThanOrEqual(7)
    })

    it.each(['..', '../organizations/1', '12 34', 'abc', '', '0', '014588072'])('makes no request for the id "%s", which is not an InPost id', async (externalId) => {
      const { ctx, methods } = context(async () => new Response(pdfBytes))
      const error = await caught(label(ctx, { externalId }))
      expect(error).toBeInstanceOf(PermanentError)
      expect(methods()).toEqual([])
    })
  })

  describe('failures of the call', () => {
    const failing = async (externalId: string) => {
      const { ctx } = await scenario('errors')
      return track(ctx, [externalId]).catch((error: unknown) => error)
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
      expect(error.message).not.toContain('Access forbidden for this token')
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
      const error = await track(ctx, ['1']).catch((thrown: unknown) => thrown)
      expect(error).toBeInstanceOf(TransientError)
      expect((error as Error).cause).toBeInstanceOf(TypeError)
    })

    it('fails as permanent, naming only paths, on an answer of another shape', async () => {
      const { ctx } = context(async () => json(200, { count: 1, page: 1, per_page: 100, items: [{ id: 5, status: 7, reference: 'Jan Kowalski' }] }))
      const error = (await track(ctx, ['5']).catch((thrown: unknown) => thrown)) as Error
      expect(error).toBeInstanceOf(PermanentError)
      expect(error.cause).toBeInstanceOf(ZodError)
      expect(error.message).toContain('items.0.status')
      expect(error.message).not.toContain('Kowalski')
    })
  })
})
