import { readdir, readFile } from 'node:fs/promises'
import {
  AuthExpiredError,
  CursorExpiredError,
  isOrderUpdate,
  orderSchema,
  PermanentError,
  TransientError,
  type Order,
  type OrderUpdate,
} from '@hanza/connector-sdk'
import {
  CONFORMANCE_CASSETTE,
  DEVICE_FLOW_CASSETTE,
  openCassette,
  REFRESH_CASSETTE,
  REFRESH_REFUSED_CASSETTE,
  runConformance,
  UNAUTHORIZED_CASSETTE,
  type MatchOptions,
} from '@hanza/connector-sdk/testing'
import { describe, expect, it } from 'vitest'
import { allegroAuth } from './auth'
import { JOURNAL_PAGE_SIZE, LISTING_PAGE_SIZE, LISTING_WINDOW_DAYS } from './capabilities/orders-pull'
import type { AllegroContext } from './client'
import { allegroConnector } from './connector'
import { decodeCursor, encodeCursor } from './cursor'
import { allegroScrub } from './scrub'
import type { AllegroApp, AllegroCredentials } from './settings'
import {
  createFakeAllegroApi,
  FAKE_ALLEGRO_NOW,
  fakeEventId,
  forms,
  sampleCheckoutForm,
  sampleListingOffer,
  type CheckoutFormPayload,
  type FakeAllegroApi,
  type FakeAllegroApiOptions,
} from './testing'

const fixtures = new URL('./fixtures/', import.meta.url)
const { capabilities } = allegroConnector
const pullOffers = capabilities['offers.pull']!
const pullOrders = capabilities['orders.pull']!
const pushStock = capabilities['stock.push']!
const pushPrices = capabilities['price.push']!
const updateStatus = capabilities['orders.updateStatus']!

// What the replay sends in place of the recorded secrets; scrubbed before matching, like the recorded ones were.
const app: AllegroApp = { clientId: 'replay-client-id', clientSecret: 'replay-client-secret', environment: 'sandbox', appName: 'Hanza Test' }
const credentials: AllegroCredentials = {
  accessToken: 'replay-access-token',
  refreshToken: 'replay-refresh-token',
  accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
}
// Recording only (HANZA_RECORD_FIXTURES=1). Against the real sandbox these would come from the git-ignored .recording/.
const recordedApp: AllegroApp = { ...app, clientId: 'recorded-client-id', clientSecret: 'recorded-client-secret' }
const recordedSecrets = [recordedApp.clientId, recordedApp.clientSecret, 'recorded-revoked-access-token', 'recorded-refused-refresh-token']

// The sample journal has one event per sample form.
const SEED_EVENTS = Object.keys(forms).length
// Allegro's journal never refuses an integer position (one it has no event for answers an empty page); it refuses a
// `from` that is not an integer with 422, as for the id the sandbox was probed with. The connector writes only ids
// Allegro issued, so this is the one expired cursor a recording can produce.
const MALFORMED_EVENT_ID = '00000000-0000-0000-0000-000000000000'
const expiredCursor = encodeCursor({ phase: 'journal', eventId: MALFORMED_EVENT_ID, boughtBefore: '2026-10-01T00:00:00.000Z' })
// The feed's boundary in the scenarios: the sample Orders were placed before it.
const BOUNDARY = '2026-10-05T00:00:00.000Z'

// Every connector error the scenarios produce, checked at the end for tokens and Buyer data.
const thrown: unknown[] = []

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    thrown.push(error)
    return error
  }
  throw new Error('expected a rejection')
}

async function signInThroughDeviceFlow(api: FakeAllegroApi, signInApp: AllegroApp): Promise<AllegroCredentials> {
  const ctx = { app: signInApp, config: {}, fetch: api.fetch, log: () => {} }
  const flow = allegroAuth.deviceFlow!
  const started = await flow.start(ctx)
  api.approve(started.userCode)
  const polled = await flow.poll(ctx, started.deviceCode)
  if (polled.status !== 'approved') throw new Error(`The device sign-in ended ${polled.status}`)
  return polled.credentials
}

interface Sent {
  method: string
  path: string
  query: Record<string, string[]>
  body: unknown
}

interface Scenario {
  ctx: AllegroContext
  /** What the connector sent, in both modes (the simulation's own `calls` exist only while recording). */
  sent: Sent[]
  /** Changes the simulation between two calls; a no-op on replay, where the cassette already holds the outcome. */
  script(change: (api: FakeAllegroApi) => void): void
  close(): Promise<void>
}

function queryOf(url: URL): Record<string, string[]> {
  const query: Record<string, string[]> = {}
  for (const [name, value] of url.searchParams) (query[name] ??= []).push(value)
  return query
}

/** A scenario cassette (`openCassette`): recorded from a fresh simulation set up by `setup`, else replayed. */
async function openScenario(
  name: string,
  setup: (api: FakeAllegroApi) => void = () => {},
  options: { api?: FakeAllegroApiOptions; match?: MatchOptions } = {},
): Promise<Scenario> {
  const live: { api?: FakeAllegroApi; credentials?: AllegroCredentials } = {}
  const cassette = await openCassette(new URL(`${name}.cassette.json`, fixtures), {
    scrub: allegroScrub,
    secrets: [credentials.accessToken, credentials.refreshToken, app.clientId, app.clientSecret],
    match: { exhausted: 'error', ...options.match },
    recording: () => {
      live.api = createFakeAllegroApi({ clientId: app.clientId, clientSecret: app.clientSecret, ...options.api })
      setup(live.api)
      live.credentials = live.api.signIn()
      return { fetch: live.api.fetch, secrets: [live.credentials.accessToken, live.credentials.refreshToken] }
    },
  })
  const sent: Sent[] = []
  const spy: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const text = await request.clone().text()
    sent.push({ method: request.method, path: url.pathname, query: queryOf(url), body: text === '' ? null : JSON.parse(text) })
    return cassette.fetch(request)
  }
  return {
    ctx: { app, config: {}, credentials: live.credentials ?? credentials, fetch: spy, log: () => {} },
    sent,
    script(change) {
      if (live.api) change(live.api)
    },
    async close() {
      await cassette.close()
      expect(cassette.misses).toEqual([])
      expect(cassette.unused()).toEqual([])
    },
  }
}

const updates = (items: Array<Order | OrderUpdate>) => items.filter(isOrderUpdate)
const fullOrders = (items: Array<Order | OrderUpdate>) => items.filter((item): item is Order => !isOrderUpdate(item))
const ids = (items: Array<Order | OrderUpdate>) => items.map((item) => (isOrderUpdate(item) ? `update:${item.externalId}` : item.externalId))

const deliveryAddress = {
  firstName: 'Ewa',
  lastName: 'Nowak',
  street: 'Garbary 5',
  city: 'Poznań',
  zipCode: '61-757',
  countryCode: 'PL',
  phoneNumber: '+48 600 000 002',
}

/** A checkout form bought at `boughtAt`, with one line. */
function formBoughtAt(id: string, boughtAt: string, overrides: Partial<CheckoutFormPayload> = {}): CheckoutFormPayload {
  const base = sampleCheckoutForm()
  return sampleCheckoutForm({
    id,
    lineItems: [{ ...base.lineItems[0]!, id: `${id.slice(0, 24)}11112222`, boughtAt }],
    payment: { type: 'ONLINE', finishedAt: boughtAt },
    updatedAt: boughtAt,
    ...overrides,
  })
}

describe('allegro connector with recorded fixtures', () => {
  it('passes the conformance kit (C1 to C18: refresh, device flow, journal, expired cursor) against its cassettes', async () => {
    await runConformance(allegroConnector, {
      fixtures,
      app,
      config: {},
      credentials,
      unauthorized: { credentials: { ...credentials, accessToken: 'replay-revoked-access-token' } },
      refresh: { refused: { credentials: { ...credentials, refreshToken: 'replay-refused-refresh-token' } } },
      deviceFlow: true,
      journal: true,
      expiredCursor,
      scrub: allegroScrub,
      recording: async () => {
        const api = createFakeAllegroApi({ clientId: recordedApp.clientId, clientSecret: recordedApp.clientSecret, autoApproveDevices: true })
        const recorded = await signInThroughDeviceFlow(api, recordedApp)
        return {
          app: recordedApp,
          credentials: recorded,
          unauthorizedCredentials: { ...recorded, accessToken: 'recorded-revoked-access-token' },
          refusedRefreshCredentials: { ...recorded, refreshToken: 'recorded-refused-refresh-token' },
          fetch: api.fetch,
          secrets: [...api.issuedTokens],
        }
      },
    })
  })

  it('keeps tokens, client credentials and Buyer data out of every committed cassette', async () => {
    // The sandbox's cassettes (`fixtures/sandbox/`) have a lint of their own in `sandbox.test.ts`.
    const names = (await readdir(fixtures)).filter((name) => name.endsWith('.cassette.json')).sort()
    for (const name of [CONFORMANCE_CASSETTE, DEVICE_FLOW_CASSETTE, REFRESH_CASSETTE, REFRESH_REFUSED_CASSETTE, UNAUTHORIZED_CASSETTE]) {
      expect(names).toContain(name)
    }
    for (const name of names) {
      const text = await readFile(new URL(name, fixtures), 'utf8')
      for (const secret of recordedSecrets) expect(text, name).not.toContain(secret)
      expect(text, name).not.toMatch(/eyJ[A-Za-z0-9_-]{4,}\./)
      expect(text.toLowerCase(), name).not.toContain('basic ')
      expect(text.toLowerCase(), name).not.toContain('bearer ')
      for (const personal of ['44051401359', '90010112345', 'Kowalska', 'Nováková', 'Nowak', 'Półwiejska', 'Garbary', '61-888', 'anna_k_test', 'gift', 'Sprzedawca']) {
        expect(text, `${name} contains ${personal}`).not.toContain(personal)
      }
    }
  })

  it('signs in through the device flow and rotates the refresh token on the simulation', async () => {
    const api = createFakeAllegroApi({ clientId: app.clientId, clientSecret: app.clientSecret })
    const ctx = { app, config: {}, fetch: api.fetch, log: () => {} }
    const flow = allegroAuth.deviceFlow!
    const started = await flow.start(ctx)
    expect(started.verificationUri).toBe('https://allegro.pl.allegrosandbox.pl/uzytkownik/bezpieczenstwo/skojarz-aplikacje')
    expect(started.userCode).toMatch(/^[a-z]{8}$/)
    expect(api.calls[0]).toMatchObject({ method: 'POST', host: 'allegro.pl.allegrosandbox.pl', path: '/auth/oauth/device', query: { client_id: [app.clientId] } })
    expect(await flow.poll(ctx, started.deviceCode)).toEqual({ status: 'pending' })
    api.approve(started.userCode)
    const approved = await flow.poll(ctx, started.deviceCode)
    expect(approved).toMatchObject({ status: 'approved', account: { id: '43784832', label: 'hanza-sandbox-seller' } })
    const signedIn = (approved as { credentials: AllegroCredentials }).credentials
    const rotated = await allegroAuth.refresh!(ctx, signedIn)
    expect(rotated.refreshToken).not.toBe(signedIn.refreshToken)
    expect(rotated.accessToken).not.toBe(signedIn.accessToken)
    // Right after the rotation the spent refresh token still works (a grace period, seen on the sandbox).
    expect((await allegroAuth.refresh!(ctx, signedIn)).refreshToken).not.toBe(rotated.refreshToken)
    api.revokeTokens()
    expect(await rejection(allegroAuth.refresh!(ctx, rotated))).toBeInstanceOf(AuthExpiredError)
    expect(await rejection(flow.poll(ctx, started.deviceCode))).toBeInstanceOf(PermanentError)
  })
})

describe('offers.pull', () => {
  it('lists every Offer but drafts and One Fulfillment ones, and asks why the sold-out one ended', async () => {
    const scenario = await openScenario('offers-pull')
    const page = await pullOffers(scenario.ctx, null)
    await scenario.close()

    expect(scenario.sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /sale/offers',
      'GET /sale/product-offers/7834566004',
    ])
    expect(scenario.sent[0]!.query).toEqual({ limit: ['1000'], offset: ['0'], 'publication.status': ['ACTIVE', 'ACTIVATING', 'ENDED'] })
    expect(page.hasMore).toBe(false)
    expect(page.nextCursor).toBe('6')
    expect(page.items).toEqual([
      {
        externalId: '7834566006',
        sku: null,
        name: 'Stoneware plate 27 cm',
        url: 'https://allegro.pl.allegrosandbox.pl/oferta/7834566006',
        // As Allegro sends it: without the trailing zero.
        price: { amount: '24.0', currency: 'PLN' },
        status: 'active',
      },
      {
        externalId: '7834566005',
        sku: 'BOWL-240-GRY',
        name: 'Salad bowl 24 cm, grey',
        url: 'https://allegro.pl.allegrosandbox.pl/oferta/7834566005',
        price: { amount: '39.99', currency: 'PLN' },
        status: 'ended',
        endedReason: 'other',
      },
      {
        externalId: '7834566004',
        sku: 'CUP-090-BLK',
        name: 'Espresso cup 90 ml, black',
        url: 'https://allegro.pl.allegrosandbox.pl/oferta/7834566004',
        price: { amount: '39.99', currency: 'PLN' },
        status: 'ended',
        endedReason: 'sold_out',
      },
      {
        externalId: '7834566003',
        sku: null,
        name: 'Vintage tea set, 12 pieces',
        url: 'https://allegro.pl.allegrosandbox.pl/oferta/7834566003',
        price: null,
        status: 'active',
      },
      {
        externalId: '7834566001',
        sku: 'MUG-350-WHT',
        name: 'Ceramic mug 350 ml, white',
        url: 'https://allegro.pl.allegrosandbox.pl/oferta/7834566001',
        price: { amount: '39.99', currency: 'PLN' },
        status: 'active',
      },
    ])
  })
})

describe('orders.pull', () => {
  it('starts from null: the journal position, then the Orders open now, then the journal', async () => {
    const scenario = await openScenario('orders-first-pull')
    const first = await pullOrders(scenario.ctx, null)
    const second = await pullOrders(scenario.ctx, first.nextCursor)
    await scenario.close()

    expect(scenario.sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /order/event-stats',
      'GET /order/checkout-forms',
      'GET /order/events',
    ])
    const cursor = decodeCursor(first.nextCursor!)
    // The boundary is Allegro's time of the event-stats answer (its `Date` header), not the local clock.
    expect(cursor).toEqual({ phase: 'journal', eventId: fakeEventId(SEED_EVENTS), boughtBefore: FAKE_ALLEGRO_NOW })
    // No status filters (single-valued on this resource): the window and the keyset only.
    expect(scenario.sent[1]!.query).toEqual({
      limit: [String(LISTING_PAGE_SIZE)],
      sort: ['lineItems.boughtAt'],
      'lineItems.boughtAt.lte': [FAKE_ALLEGRO_NOW],
      'lineItems.boughtAt.gte': [new Date(Date.parse(FAKE_ALLEGRO_NOW) - LISTING_WINDOW_DAYS * 86_400_000).toISOString()],
    })
    expect(scenario.sent[2]!.query).toEqual({ from: [fakeEventId(SEED_EVENTS)], limit: [String(JOURNAL_PAGE_SIZE)] })

    // Open now: paid, cash on delivery, and the unpaid ones; never shipped, cancelled or One Fulfillment. A form
    // bought with no address at all cannot be a full Order: an update, which the core ignores for an Order it lacks.
    expect(first.hasMore).toBe(true)
    expect(updates(first.items).map((update) => update.externalId)).toEqual([forms.boughtNoAddress.id])
    expect(fullOrders(first.items).map((order) => order.externalId).sort()).toEqual(
      [
        forms.paidOnline,
        forms.cashOnDelivery,
        forms.companyInvoice,
        forms.personalInvoice,
        forms.pickupPoint,
        forms.multiLine,
        forms.buyerWithoutName,
        forms.filledInUnpaid,
        forms.boughtAccountAddress,
        forms.allegroCz,
      ]
        .map((form) => form.id)
        .sort(),
    )
    const unpaid = fullOrders(first.items).find((order) => order.externalId === forms.filledInUnpaid.id)!
    expect(unpaid.awaitingPayment).toBe(true)
    expect(unpaid.facts).toEqual([])
    const bought = fullOrders(first.items).find((order) => order.externalId === forms.boughtAccountAddress.id)!
    expect(bought).toMatchObject({ awaitingPayment: true, facts: [] })
    const paid = fullOrders(first.items).find((order) => order.externalId === forms.paidOnline.id)!
    expect(paid).toMatchObject({
      awaitingPayment: false,
      payment: 'prepaid',
      total: { amount: '94.97', currency: 'PLN' },
      facts: [{ id: `${forms.paidOnline.id}:paid`, type: 'paid', occurredAt: '2026-10-01T09:10:00.000Z', note: null }],
    })
    const czk = fullOrders(first.items).find((order) => order.externalId === forms.allegroCz.id)!
    expect(czk.total).toEqual({ amount: '1089.00', currency: 'CZK' })
    expect(czk.lines.map((line) => line.unitPrice)).toEqual([{ amount: '990.00', currency: 'CZK' }])

    // The journal has nothing after the start: the same cursor back, nothing more.
    expect(second).toEqual({ items: [], nextCursor: first.nextCursor, hasMore: false })
  })

  it('follows the journal: full Orders only after the boundary, updates before it, a removed form cancelled', async () => {
    const afterBoundary = formBoughtAt('3f6c0a51-c4e9-11f1-9a51-2c51a0f00001', '2026-10-06T09:00:00.000Z')
    const cancelledWithoutAddress = formBoughtAt('3f6c0a51-c4e9-11f1-9a51-2c51a0f00002', '2026-10-06T09:30:00.000Z', {
      status: 'CANCELLED',
      buyer: { ...sampleCheckoutForm().buyer, address: null },
      payment: { type: 'ONLINE' },
      delivery: null,
      updatedAt: '2026-10-06T11:00:00.000Z',
    })
    // Lines bought on both sides of the boundary: the latest purchase time decides, `placedAt` stays the earliest.
    const straddling = formBoughtAt('3f6c0a51-c4e9-11f1-9a51-2c51a0f00003', '2026-10-04T23:00:00.000Z', {
      lineItems: [
        { ...sampleCheckoutForm().lineItems[0]!, id: '3f6c0a51-c4e9-11f1-9a51-2c51a0f10003', boughtAt: '2026-10-04T23:00:00.000Z' },
        { ...sampleCheckoutForm().lineItems[0]!, id: '3f6c0a51-c4e9-11f1-9a51-2c51a0f20003', boughtAt: '2026-10-05T01:00:00.000Z' },
      ],
      updatedAt: '2026-10-05T01:05:00.000Z',
    })
    const start = encodeCursor({ phase: 'journal', eventId: fakeEventId(SEED_EVENTS), boughtBefore: BOUNDARY })
    const scenario = await openScenario('orders-journal', (api) => {
      // Shipped in Allegro's panel: an Order placed before the boundary.
      api.setForm({ ...forms.paidOnline, fulfillment: { status: 'SENT', provider: { id: 'SELLER' } }, updatedAt: '2026-10-06T08:00:00.000Z' })
      api.addEvent('FULFILLMENT_STATUS_CHANGED', forms.paidOnline.id, '2026-10-06T08:00:00.000Z')
      // Placed after the boundary; two events, one Order.
      api.setForm(afterBoundary)
      api.addEvent('BOUGHT', afterBoundary.id, '2026-10-06T09:00:00.000Z')
      api.addEvent('READY_FOR_PROCESSING', afterBoundary.id, '2026-10-06T09:05:00.000Z')
      // Merged into another purchase: the form is gone.
      api.addEvent('BUYER_MODIFIED', forms.cashOnDelivery.id, '2026-10-06T10:00:00.000Z')
      api.removeForm(forms.cashOnDelivery.id)
      // Skipped: One Fulfillment, no address yet, no checkout form at all.
      api.addEvent('READY_FOR_PROCESSING', forms.oneFulfillment.id, '2026-10-06T10:05:00.000Z')
      api.addEvent('BOUGHT', forms.boughtNoAddress.id, '2026-10-06T10:10:00.000Z')
      api.addEvent('BOUGHT', null, '2026-10-06T10:15:00.000Z')
      // Placed after the boundary but never filled in, then cancelled: no address, so only an update.
      api.setForm(cancelledWithoutAddress)
      api.addEvent('AUTO_CANCELLED', cancelledWithoutAddress.id, '2026-10-06T11:00:00.000Z')
      api.setForm(straddling)
      api.addEvent('READY_FOR_PROCESSING', straddling.id, '2026-10-06T11:30:00.000Z')
    })
    const page = await pullOrders(scenario.ctx, start)
    const tail = await pullOrders(scenario.ctx, page.nextCursor)
    await scenario.close()

    expect(scenario.sent[0]).toMatchObject({ path: '/order/events', query: { from: [fakeEventId(SEED_EVENTS)], limit: ['100'] } })
    // One request per distinct form, never one for the event without a form.
    expect(scenario.sent.filter(({ path }) => path.startsWith('/order/checkout-forms/')).map(({ path }) => path.split('/').at(-1)).sort()).toEqual(
      [
        forms.paidOnline.id,
        afterBoundary.id,
        forms.cashOnDelivery.id,
        forms.oneFulfillment.id,
        forms.boughtNoAddress.id,
        cancelledWithoutAddress.id,
        straddling.id,
      ].sort(),
    )
    // A paid Order after the boundary comes in full and, right after it, as an update carrying its addresses.
    expect(ids(page.items)).toEqual([
      `update:${forms.paidOnline.id}`,
      afterBoundary.id,
      `update:${afterBoundary.id}`,
      `update:${forms.cashOnDelivery.id}`,
      `update:${cancelledWithoutAddress.id}`,
      straddling.id,
      `update:${straddling.id}`,
    ])
    const [shipped, placed, placedUpdate, removed, cancelled, straddled] = page.items as [
      OrderUpdate,
      Order,
      OrderUpdate,
      OrderUpdate,
      OrderUpdate,
      Order,
    ]
    expect(placedUpdate.shippingAddress).toEqual(placed.shippingAddress)
    expect(placedUpdate.facts).toEqual(placed.facts)
    expect(straddled.placedAt).toBe('2026-10-04T23:00:00.000Z')
    expect(shipped.facts).toEqual([
      { id: `${forms.paidOnline.id}:paid`, type: 'paid', occurredAt: '2026-10-01T09:10:00.000Z', note: null },
      { id: `${forms.paidOnline.id}:shipped`, type: 'shipped', occurredAt: '2026-10-06T08:00:00.000Z', note: null },
    ])
    // Paid: the update carries the addresses (they replace the stored ones only while the Order is new).
    expect(shipped.shippingAddress).toMatchObject({ countryCode: 'PL' })
    expect(shipped.billingAddress).toBeNull()
    expect(orderSchema.safeParse(placed).success).toBe(true)
    expect(placed).toMatchObject({ placedAt: '2026-10-06T09:00:00.000Z', awaitingPayment: false })
    expect(removed).toEqual({
      kind: 'update',
      externalId: forms.cashOnDelivery.id,
      facts: [{ id: `${forms.cashOnDelivery.id}:removed`, type: 'cancelled', occurredAt: '2026-10-06T10:00:00.000Z', note: 'Merged into another order on the Channel' }],
    })
    expect(cancelled).toEqual({
      kind: 'update',
      externalId: cancelledWithoutAddress.id,
      facts: [{ id: `${cancelledWithoutAddress.id}:cancelled`, type: 'cancelled', occurredAt: '2026-10-06T11:00:00.000Z', note: null }],
    })
    expect(page.hasMore).toBe(false)
    expect(decodeCursor(page.nextCursor!)).toEqual({ phase: 'journal', eventId: fakeEventId(SEED_EVENTS + 9), boughtBefore: BOUNDARY })
    expect(tail).toEqual({ items: [], nextCursor: page.nextCursor, hasMore: false })
  })

  it('reports an unpaid Order awaiting payment, then its payment with the delivery address', async () => {
    const accountOnly = { delivery: { method: { id: '1fa56f79-4b6a-4821-a6f2-ca9c16d5c925', name: 'Allegro Kurier DPD' } } }
    const unpaidBefore = formBoughtAt('7a2e4c10-c4ea-11f1-8f00-1a2b3c4d0001', '2026-10-03T10:00:00.000Z', {
      status: 'FILLED_IN',
      payment: { type: 'ONLINE' },
      ...accountOnly,
    })
    const unpaidAfter = formBoughtAt('7a2e4c10-c4ea-11f1-8f00-1a2b3c4d0002', '2026-10-06T10:00:00.000Z', {
      status: 'FILLED_IN',
      payment: { type: 'ONLINE' },
      ...accountOnly,
    })
    const paid = (form: CheckoutFormPayload, at: string): CheckoutFormPayload => ({
      ...form,
      status: 'READY_FOR_PROCESSING',
      payment: { type: 'ONLINE', finishedAt: at, paidAmount: { amount: '94.97', currency: 'PLN' } },
      delivery: { ...accountOnly.delivery, address: deliveryAddress },
      updatedAt: at,
    })
    const scenario = await openScenario('orders-unpaid', () => {}, { api: { forms: [unpaidBefore] } })
    const listing = await pullOrders(scenario.ctx, encodeCursor({ phase: 'listing', eventId: fakeEventId(1), boughtBefore: BOUNDARY, lastBoughtAt: null }))
    scenario.script((api) => {
      api.setForm(unpaidAfter)
      api.addEvent('FILLED_IN', unpaidAfter.id, '2026-10-06T10:01:00.000Z')
    })
    const placed = await pullOrders(scenario.ctx, listing.nextCursor)
    scenario.script((api) => {
      api.setForm(paid(unpaidBefore, '2026-10-06T12:00:00.000Z'))
      api.addEvent('READY_FOR_PROCESSING', unpaidBefore.id, '2026-10-06T12:00:00.000Z')
      api.setForm(paid(unpaidAfter, '2026-10-06T12:30:00.000Z'))
      api.addEvent('READY_FOR_PROCESSING', unpaidAfter.id, '2026-10-06T12:30:00.000Z')
    })
    const paidPage = await pullOrders(scenario.ctx, placed.nextCursor)
    await scenario.close()

    // Listed before the boundary, unpaid: the account address stands in until the Buyer pays.
    const [listed] = listing.items as [Order]
    expect(listing.items).toHaveLength(1)
    expect(listed).toMatchObject({ externalId: unpaidBefore.id, awaitingPayment: true, facts: [] })
    expect(decodeCursor(listing.nextCursor!)).toEqual({ phase: 'journal', eventId: fakeEventId(1), boughtBefore: BOUNDARY })

    expect(ids(placed.items)).toEqual([unpaidAfter.id])
    expect((placed.items[0] as Order).awaitingPayment).toBe(true)

    // Before the boundary only the update; after it the full Order (facts) and then the update (the delivery address).
    expect(ids(paidPage.items)).toEqual([`update:${unpaidBefore.id}`, unpaidAfter.id, `update:${unpaidAfter.id}`])
    const [update, order, orderUpdate] = paidPage.items as [OrderUpdate, Order, OrderUpdate]
    expect(update.facts).toEqual([{ id: `${unpaidBefore.id}:paid`, type: 'paid', occurredAt: '2026-10-06T12:00:00.000Z', note: null }])
    expect(update.shippingAddress).toBeDefined()
    expect(update.shippingAddress).not.toEqual(listed.shippingAddress)
    expect(update.billingAddress).toBeNull()
    expect(order).toMatchObject({ awaitingPayment: false, facts: [{ id: `${unpaidAfter.id}:paid`, type: 'paid' }] })
    expect(order.shippingAddress).toEqual(update.shippingAddress)
    expect(orderUpdate).toMatchObject({ shippingAddress: update.shippingAddress, billingAddress: null, facts: order.facts })
  })

  it('pages the listing by purchase time, so an Order closing between two pages skips no other', async () => {
    const count = LISTING_PAGE_SIZE + 2
    const listed = Array.from({ length: count }, (_, index) => {
      const n = index + 1
      const boughtAt = new Date(Date.parse('2026-09-20T00:00:00.000Z') + n * 60_000).toISOString()
      return compactForm(`9b1e7d00-c4eb-11f1-b000-${String(n).padStart(12, '0')}`, boughtAt)
    })
    // Already shipped: on the page (the query cannot filter by status), left out by the connector.
    listed[9] = { ...listed[9]!, fulfillment: { status: 'SENT', provider: { id: 'SELLER' } } }
    const scenario = await openScenario('orders-listing-pages', () => {}, { api: { forms: listed, journal: [] } })
    const start = encodeCursor({ phase: 'listing', eventId: null, boughtBefore: BOUNDARY, lastBoughtAt: null })
    const first = await pullOrders(scenario.ctx, start)
    // Shipped between the two pages; with offset paging the next page would start one Order too late.
    scenario.script((api) => api.setForm({ ...listed[49]!, fulfillment: { status: 'SENT', provider: { id: 'SELLER' } } }))
    const second = await pullOrders(scenario.ctx, first.nextCursor)
    const journal = await pullOrders(scenario.ctx, second.nextCursor)
    await scenario.close()

    expect(first.items).toHaveLength(LISTING_PAGE_SIZE - 1)
    expect(ids(first.items)).not.toContain(listed[9]!.id)
    expect(first.hasMore).toBe(true)
    expect(decodeCursor(first.nextCursor!)).toEqual({ phase: 'listing', eventId: null, boughtBefore: BOUNDARY, lastBoughtAt: listed[99]!.lineItems[0]!.boughtAt })
    // The first page starts at the window (30 days before the boundary), the next at the last key listed.
    expect(scenario.sent[0]!.query['lineItems.boughtAt.gte']).toEqual(['2026-09-05T00:00:00.000Z'])
    expect(scenario.sent[1]!.query['lineItems.boughtAt.gte']).toEqual([listed[99]!.lineItems[0]!.boughtAt])
    // The last Order of the first page again (same key), then the rest.
    expect(ids(second.items)).toEqual([listed[99]!.id, listed[100]!.id, listed[101]!.id])
    expect(decodeCursor(second.nextCursor!)).toEqual({ phase: 'journal', eventId: null, boughtBefore: BOUNDARY })
    expect(new Set([...ids(first.items), ...ids(second.items)])).toEqual(new Set(listed.filter((_, index) => index !== 9).map((form) => form.id)))
    // An empty journal: no `from`, nothing yet.
    expect(scenario.sent[2]!.query).toEqual({ limit: ['100'] })
    expect(journal).toEqual({ items: [], nextCursor: second.nextCursor, hasMore: false })
  })

  it('fails with CursorExpiredError when the journal refuses the position, reads an unknown one as empty, and keeps a 401 a sign-in problem', async () => {
    const scenario = await openScenario('orders-expired-cursor')
    const expired = await rejection(pullOrders(scenario.ctx, encodeCursor({ phase: 'journal', eventId: MALFORMED_EVENT_ID, boughtBefore: BOUNDARY })))
    // An integer the journal has no event for (here the largest it takes) is not refused: an empty page, the same cursor.
    const beyond = encodeCursor({ phase: 'journal', eventId: '9223372036854775807', boughtBefore: BOUNDARY })
    const empty = await pullOrders(scenario.ctx, beyond)
    const kept = await pullOrders(scenario.ctx, encodeCursor({ phase: 'journal', eventId: fakeEventId(SEED_EVENTS), boughtBefore: BOUNDARY }))
    scenario.script((api) => api.revokeTokens())
    const signedOut = await rejection(pullOrders(scenario.ctx, encodeCursor({ phase: 'journal', eventId: fakeEventId(SEED_EVENTS), boughtBefore: BOUNDARY })))
    await scenario.close()

    expect(scenario.sent[0]).toMatchObject({ path: '/order/events', query: { from: [MALFORMED_EVENT_ID], limit: ['100'] } })
    expect(expired).toBeInstanceOf(CursorExpiredError)
    expect(empty).toEqual({ items: [], nextCursor: beyond, hasMore: false })
    expect(kept).toMatchObject({ items: [], hasMore: false })
    expect(signedOut).toBeInstanceOf(AuthExpiredError)
  })

  it('takes a 400 or 404 with an Allegro error body for a journal position as an expired cursor too, but not without a position', async () => {
    // Never seen on the sandbox (it answers 422): a guard in case Allegro changes how it refuses a position.
    for (const status of [400, 404]) {
      const answer: typeof fetch = async () => new Response(JSON.stringify({ errors: [{ code: 'NOT_FOUND' }] }), { status })
      const ctx: AllegroContext = { app, config: {}, credentials, fetch: answer, log: () => {} }
      expect(await rejection(pullOrders(ctx, encodeCursor({ phase: 'journal', eventId: fakeEventId(2), boughtBefore: BOUNDARY })))).toBeInstanceOf(
        CursorExpiredError,
      )
    }

    // An empty-journal start has no `from`: nothing can have expired, so the same statuses stay permanent.
    for (const status of [400, 404, 422]) {
      const answer: typeof fetch = async () => new Response(JSON.stringify({ errors: [{ code: 'VALIDATION_ERROR' }] }), { status })
      const ctx: AllegroContext = { app, config: {}, credentials, fetch: answer, log: () => {} }
      const error = await rejection(pullOrders(ctx, encodeCursor({ phase: 'journal', eventId: null, boughtBefore: BOUNDARY })))
      expect(error).toBeInstanceOf(PermanentError)
      expect(error).not.toBeInstanceOf(CursorExpiredError)
    }

    // With a position but no Allegro error body (a proxy's page, an empty answer): not a sign of an expired position.
    for (const body of [null, '<html>Not Found</html>', JSON.stringify({ errors: [] })]) {
      const answer: typeof fetch = async () => new Response(body, { status: 404 })
      const ctx: AllegroContext = { app, config: {}, credentials, fetch: answer, log: () => {} }
      const error = await rejection(pullOrders(ctx, encodeCursor({ phase: 'journal', eventId: fakeEventId(2), boughtBefore: BOUNDARY })))
      expect(error).toBeInstanceOf(PermanentError)
      expect(error).not.toBeInstanceOf(CursorExpiredError)
    }
  })

  it('refuses a cursor it did not write', async () => {
    const ctx: AllegroContext = { app, config: {}, credentials, fetch: () => Promise.reject(new Error('no request expected')), log: () => {} }
    expect(await rejection(pullOrders(ctx, 'x1:whatever'))).toBeInstanceOf(PermanentError)
    expect(await rejection(pullOffers(ctx, '-5'))).toBeInstanceOf(PermanentError)
  })
})

describe('stock.push', () => {
  const levels = [
    { offerExternalId: '7834566001', sku: 'MUG-350-WHT', available: 7 },
    { offerExternalId: '7834566006', sku: null, available: 0 },
    { offerExternalId: '7834566008', sku: 'MUG-350-WHT', available: 0 },
    { offerExternalId: '7834566004', sku: 'CUP-090-BLK', available: 3 },
    { offerExternalId: '7834566009', sku: 'SUGAR-BOWL-01', available: 2 },
    { offerExternalId: '7834566005', sku: 'BOWL-240-GRY', available: 2 },
    { offerExternalId: '7834566003', sku: null, available: 4 },
    { offerExternalId: '7834566007', sku: 'MUG-350-WHT', available: 1 },
    { offerExternalId: '7834569999', sku: null, available: 1 },
    { offerExternalId: '7834566010', sku: 'SAUCER-01', available: 0 },
  ]

  it('sets each Offer, ends it at 0, reopens only a sold-out one, and reports refusals per Offer', async () => {
    const soldOut = (id: string, name: string, sku: string) => ({
      listing: sampleListingOffer({ id, name, stock: { available: 0 }, publication: { status: 'ENDED' }, external: { id: sku } }),
      endedBy: 'EMPTY_STOCK',
    })
    const scenario = await openScenario('stock-push', (api) => {
      // Accepted for processing: a 202 showing the Offer as it was.
      api.acceptLater('7834566001')
      // A second sold-out Offer, whose reopen meets an edit still being processed (a 409 never seen on the sandbox).
      api.state.offers.set('7834566009', soldOut('7834566009', 'Sugar bowl, white', 'SUGAR-BOWL-01'))
      api.conflictReopen('7834566009')
      // Sold out already: a 0 leaves it ended.
      api.state.offers.set('7834566010', soldOut('7834566010', 'Saucer, white', 'SAUCER-01'))
      api.rejectOffer('7834566003', 'ConstraintViolationException.QuantityTooHigh')
      api.forbidOffer('7834566007')
    })
    const results = await pushStock(scenario.ctx, levels)
    // An earlier edit still being processed: a 409 on the stock edit fails the whole push, to be retried.
    scenario.script((api) => api.conflictOffer('7834566001'))
    const conflict = await rejection(pushStock(scenario.ctx, [{ offerExternalId: '7834566001', sku: 'MUG-350-WHT', available: 5 }]))
    const sentBefore = scenario.sent.length
    expect(await pushStock(scenario.ctx, [])).toEqual([])
    expect(scenario.sent).toHaveLength(sentBefore)
    await scenario.close()

    expect(results).toEqual([
      { offerExternalId: '7834566001', outcome: 'ok' },
      // The answer still shows the Offer active (Allegro ends it seconds later): a 0 is `ended` all the same.
      { offerExternalId: '7834566006', outcome: 'ended' },
      // A draft given 0 stays a draft: set, not ended.
      { offerExternalId: '7834566008', outcome: 'ok' },
      // Set, still ended (`EMPTY_STOCK`), then reopened: the reopen answers 202 showing the Offer still ended.
      { offerExternalId: '7834566004', outcome: 'ok' },
      { offerExternalId: '7834566009', outcome: 'rejected', code: 'OFFER_REOPEN_PENDING' },
      { offerExternalId: '7834566005', outcome: 'rejected', code: 'OFFER_ENDED_USER' },
      { offerExternalId: '7834566003', outcome: 'rejected', code: 'ConstraintViolationException.QuantityTooHigh' },
      { offerExternalId: '7834566007', outcome: 'rejected', code: 'FORBIDDEN' },
      { offerExternalId: '7834569999', outcome: 'rejected', code: 'OFFER_NOT_FOUND' },
      { offerExternalId: '7834566010', outcome: 'ended' },
    ])
    const patches = scenario.sent
      .slice(0, -1)
      .map(({ method, path, body }) => `${method} ${path.split('/').at(-1)} ${JSON.stringify(body)}`)
      .sort()
    expect(patches).toEqual(
      [
        'PATCH 7834566001 {"stock":{"available":7}}',
        'PATCH 7834566006 {"stock":{"available":0}}',
        'PATCH 7834566008 {"stock":{"available":0}}',
        'PATCH 7834566004 {"stock":{"available":3}}',
        'PATCH 7834566004 {"publication":{"status":"ACTIVE"}}',
        'PATCH 7834566009 {"stock":{"available":2}}',
        'PATCH 7834566009 {"publication":{"status":"ACTIVE"}}',
        'PATCH 7834566005 {"stock":{"available":2}}',
        'PATCH 7834566003 {"stock":{"available":4}}',
        'PATCH 7834566007 {"stock":{"available":1}}',
        'PATCH 7834569999 {"stock":{"available":1}}',
        'PATCH 7834566010 {"stock":{"available":0}}',
      ].sort(),
    )
    expect(conflict).toBeInstanceOf(TransientError)
  })

  it('fails the whole push when every Offer answers 403: a missing scope, not one Offer', async () => {
    const forbidden: typeof fetch = async () => new Response(JSON.stringify({ errors: [{ code: 'ACCESS_DENIED' }] }), { status: 403 })
    const ctx: AllegroContext = { app, config: {}, credentials, fetch: forbidden, log: () => {} }
    const error = await rejection(pushStock(ctx, levels.slice(0, 3)))
    expect(error).toBeInstanceOf(PermanentError)
    expect((error as Error).message).toContain('403')
  })
})

describe('price.push', () => {
  const prices = [
    { offerExternalId: '7834566001', sku: 'MUG-350-WHT', price: { amount: '42', currency: 'PLN' } },
    { offerExternalId: '7834566004', sku: 'CUP-090-BLK', price: { amount: '12.50', currency: 'PLN' } },
    { offerExternalId: '7834566005', sku: 'BOWL-240-GRY', price: { amount: '59.90', currency: 'EUR' } },
    { offerExternalId: '7834566006', sku: null, price: { amount: '0.50', currency: 'PLN' } },
    { offerExternalId: '7834566008', sku: null, price: { amount: '18.00', currency: 'PLN' } },
    { offerExternalId: '7834566007', sku: 'MUG-350-WHT', price: { amount: '9.99', currency: 'PLN' } },
    { offerExternalId: '7834569999', sku: null, price: { amount: '9.99', currency: 'PLN' } },
  ]

  it('sets each price as sent, and reports refusals per Offer', async () => {
    const scenario = await openScenario('price-push', (api) => {
      // Accepted for processing: a 202 showing the Offer as it was.
      api.acceptLater('7834566004')
      api.rejectOffer('7834566008', 'OfferPriceChangeLocked')
      api.forbidOffer('7834566007')
    })
    const results = await pushPrices(scenario.ctx, prices)
    const listed = await pullOffers(scenario.ctx, null)
    // An earlier edit still being processed: a 409 fails the whole push, to be retried.
    scenario.script((api) => api.conflictOffer('7834566001'))
    const conflict = await rejection(pushPrices(scenario.ctx, prices.slice(0, 1)))
    // Every Offer of the call refused with 403: a missing scope, not one Offer.
    const forbidden = await rejection(pushPrices(scenario.ctx, prices.filter(({ offerExternalId }) => offerExternalId === '7834566007')))
    const sentBefore = scenario.sent.length
    expect(await pushPrices(scenario.ctx, [])).toEqual([])
    expect(scenario.sent).toHaveLength(sentBefore)
    await scenario.close()

    expect(results).toEqual([
      { offerExternalId: '7834566001', outcome: 'ok' },
      // An ended Offer takes a price too (seen on the sandbox); a 202 is accepted whatever it shows.
      { offerExternalId: '7834566004', outcome: 'ok' },
      // Allegro's codes, as the sandbox gave them for EUR on an allegro.pl Offer and for a price below 1.00 PLN.
      { offerExternalId: '7834566005', outcome: 'rejected', code: 'IncorrectBaseCurrency' },
      { offerExternalId: '7834566006', outcome: 'rejected', code: 'PriceBelowMin' },
      { offerExternalId: '7834566008', outcome: 'rejected', code: 'OfferPriceChangeLocked' },
      { offerExternalId: '7834566007', outcome: 'rejected', code: 'FORBIDDEN' },
      { offerExternalId: '7834569999', outcome: 'rejected', code: 'OFFER_NOT_FOUND' },
    ])
    const patches = scenario.sent.filter(({ method }) => method === 'PATCH')
    expect(patches.slice(0, prices.length).map(({ path, body }) => `${path.split('/').at(-1)} ${JSON.stringify(body)}`).sort()).toEqual(
      prices.map(({ offerExternalId, price }) => `${offerExternalId} ${JSON.stringify({ sellingMode: { price } })}`).sort(),
    )
    // The listing writes the price Allegro now has as a double.
    expect(listed.items.find(({ externalId }) => externalId === '7834566001')?.price).toEqual({ amount: '42.0', currency: 'PLN' })
    expect(conflict).toBeInstanceOf(TransientError)
    expect(forbidden).toBeInstanceOf(PermanentError)
    expect((forbidden as Error).message).toContain('403')
  })
})

describe('orders.updateStatus', () => {
  it('sets the fulfillment status for every Order phase, and fails on an unknown Order or a revoked token', async () => {
    const id = forms.paidOnline.id
    const scenario = await openScenario('orders-update-status')
    for (const phase of ['new', 'processing', 'shipped', 'cancelled'] as const) await updateStatus(scenario.ctx, { orderExternalId: id, phase })
    // Allegro answers an unknown form 422 here (seen on the sandbox), not 404.
    const unknown = await rejection(updateStatus(scenario.ctx, { orderExternalId: '00000000-0000-1000-8000-000000000000', phase: 'shipped' }))
    scenario.script((api) => api.revokeTokens())
    const signedOut = await rejection(updateStatus(scenario.ctx, { orderExternalId: id, phase: 'processing' }))
    await scenario.close()

    expect(scenario.sent.slice(0, 4)).toEqual(
      ['NEW', 'PROCESSING', 'SENT', 'CANCELLED'].map((status) => ({
        method: 'PUT',
        path: `/order/checkout-forms/${id}/fulfillment`,
        query: {},
        body: { status },
      })),
    )
    expect(unknown).toBeInstanceOf(PermanentError)
    expect(signedOut).toBeInstanceOf(AuthExpiredError)
  })
})

describe('error messages', () => {
  it('never carry a token, a client secret, a name or an e-mail', () => {
    expect(thrown.length).toBeGreaterThan(5)
    const forbidden = [
      ...Object.values(credentials),
      app.clientSecret,
      'Anna',
      'Kowalska',
      'Ewa',
      'Nowak',
      'Półwiejska',
      '44051401359',
      '90010112345',
    ]
    for (const error of thrown) {
      const message = error instanceof Error ? error.message : String(error)
      for (const value of forbidden) expect(message).not.toContain(value)
      expect(message).not.toMatch(/@|eyJ/)
    }
  })
})

/** A checkout form with only the fields the connector reads (and a name and address to scrub), to keep the cassette small. */
function compactForm(id: string, boughtAt: string): CheckoutFormPayload {
  return {
    id,
    status: 'READY_FOR_PROCESSING',
    buyer: { id: '23123199', email: 'buyer@example.com', login: 'buyer_test', firstName: 'Ewa', lastName: 'Nowak' },
    payment: { type: 'ONLINE', finishedAt: boughtAt },
    fulfillment: { status: 'NEW', provider: { id: 'SELLER' } },
    delivery: { address: { firstName: 'Ewa', lastName: 'Nowak', street: 'Garbary 5', city: 'Poznań', zipCode: '61-757', countryCode: 'PL' } },
    lineItems: [
      {
        id: `${id.slice(0, 24)}aaaa${id.slice(-8)}`,
        offer: { id: '7834566001', name: 'Ceramic mug 350 ml, white' },
        quantity: 1,
        price: { amount: '39.99', currency: 'PLN' },
        boughtAt,
      },
    ],
    summary: { totalToPay: { amount: '39.99', currency: 'PLN' } },
    updatedAt: boughtAt,
  }
}
