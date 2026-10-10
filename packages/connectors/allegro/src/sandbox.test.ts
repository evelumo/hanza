import { readdir, readFile, writeFile } from 'node:fs/promises'
import { isOrderUpdate, PermanentError, type Order, type OrderUpdate } from '@hanza/connector-sdk'
import {
  CONFORMANCE_CASSETTE,
  DEVICE_FLOW_CASSETTE,
  isRecording,
  openCassette,
  REFRESH_CASSETTE,
  REFRESH_REFUSED_CASSETTE,
  runConformance,
  UNAUTHORIZED_CASSETTE,
} from '@hanza/connector-sdk/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AllegroContext } from './client'
import { allegroConnector } from './connector'
import { decodeCursor, encodeCursor } from './cursor'
import { allegroScrub } from './scrub'
import { allegroAppConfigSchema, allegroCredentialsSchema, type AllegroApp, type AllegroCredentials } from './settings'

/*
 * The same connector against cassettes recorded from the real Allegro sandbox (seller "Hanza", id 111578766), on
 * 2026-10-10. `connector.test.ts` proves the edge cases on a simulation; this file proves the main paths on real
 * traffic. Re-recording needs a signed-in seller's tokens in the git-ignored `.recording/` (see AGENTS.md, "Fixtures").
 */

const fixtures = new URL('./fixtures/sandbox/', import.meta.url)
const recordingDir = new URL('../.recording/', import.meta.url)
const credentialsFile = new URL('credentials.json', recordingDir)
const { capabilities } = allegroConnector
const pullOffers = capabilities['offers.pull']!
const pullOrders = capabilities['orders.pull']!
const pushStock = capabilities['stock.push']!
const pushPrices = capabilities['price.push']!
const updateStatus = capabilities['orders.updateStatus']!

const recording = isRecording()
// Live requests, and the waits for Allegro's asynchronous Offer edits, take far longer than a replay.
const timeout = recording ? 300_000 : 10_000

// What the replay sends in place of the recorded secrets; scrubbed before matching, like the recorded ones were.
const app: AllegroApp = { clientId: 'replay-client-id', clientSecret: 'replay-client-secret', environment: 'sandbox', appName: 'Hanza Test' }
const credentials: AllegroCredentials = {
  accessToken: 'replay-access-token',
  refreshToken: 'replay-refresh-token',
  accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
}

// A `from` that is not an integer: the one journal position the real API refuses (422 → CursorExpiredError).
const expiredCursor = encodeCursor({ phase: 'journal', eventId: 'expired', boughtBefore: '2026-10-01T00:00:00.000Z' })

const forms = {
  paidMugs: '7721b2f0-c4e8-11f1-904f-89bb34047197',
  unpaidMug: '9e806f30-c4e8-11f1-904f-89bb34047197',
  paidPlate: 'b24a5a30-c4e8-11f1-904f-89bb34047197',
}
// The first BOUGHT of the seller's journal; the purchases happened 2026-10-10T20:24–20:26Z.
const FIRST_EVENT = '1791663869066571'
// The seller's Offers and their buy-now prices as set up (the listing writes them as doubles: `19.9`, `24.0`).
const PRICES: Record<string, string> = {
  '7782361660': '19.90',
  '7782361659': '19.90',
  '7782361658': '24.00',
  '7782361657': '34.50',
  '7782361656': '39.99',
}

interface RecordingAccount {
  app: AllegroApp
  credentials: AllegroCredentials
  account: unknown
}

async function loadRecordingAccount(): Promise<RecordingAccount> {
  const saved = JSON.parse(await readFile(credentialsFile, 'utf8')) as { account?: unknown }
  return {
    app: allegroAppConfigSchema.parse(JSON.parse(await readFile(new URL('app.json', recordingDir), 'utf8'))),
    // The schema strips `account` and `previous`.
    credentials: allegroCredentialsSchema.parse(saved),
    account: saved.account,
  }
}

const secretsOf = ({ app: real, credentials: tokens }: RecordingAccount) => [tokens.accessToken, tokens.refreshToken, real.clientId, real.clientSecret]

/**
 * The real `fetch`, writing every token pair the token endpoint issues back to `.recording/credentials.json`: Allegro
 * rotates both tokens on each refresh (C15 does one), so without this the seller's sign-in would be lost.
 */
function tokenPersistingFetch(account: unknown): typeof fetch {
  return async (input, init) => {
    const response = await globalThis.fetch(input, init)
    const url = input instanceof Request ? input.url : String(input)
    if (response.ok && new URL(url).pathname.endsWith('/auth/oauth/token')) {
      const body = (await response.clone().json()) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown }
      if (typeof body.access_token === 'string' && typeof body.refresh_token === 'string') {
        const seconds = typeof body.expires_in === 'number' ? body.expires_in : 43_199
        const tokens = {
          accessToken: body.access_token,
          refreshToken: body.refresh_token,
          accessTokenExpiresAt: new Date(Date.now() + seconds * 1000).toISOString(),
          account,
        }
        await writeFile(credentialsFile, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 })
      }
    }
    return response
  }
}

/**
 * Recording only, sent outside any cassette: sets the Offers' prices back to `PRICES` (C13 pushes 19.99 and then 25 to
 * the first three, `sandbox-price-push` 21.50 to one), so the next run lists what `sandbox-offers-pull` expects. The
 * listing shows a new price some seconds after the edit answered (seen on the sandbox), hence the wait.
 */
async function restorePrices(): Promise<void> {
  if (!recording) return
  const real = await loadRecordingAccount()
  const ctx: AllegroContext = { app: real.app, config: {}, credentials: real.credentials, fetch: tokenPersistingFetch(real.account), log: () => {} }
  const prices = Object.entries(PRICES).map(([offerExternalId, amount]) => ({ offerExternalId, sku: null, price: { amount, currency: 'PLN' } }))
  expect(await pushPrices(ctx, prices)).toEqual(prices.map(({ offerExternalId }) => ({ offerExternalId, outcome: 'ok' })))
  await waitForAllegro(10_000)
}

/** Allegro applies the publication side of an Offer edit seconds after it answers; a replay needs no wait. */
async function waitForAllegro(ms: number): Promise<void> {
  if (recording) await new Promise((resolve) => setTimeout(resolve, ms))
}

interface Sent {
  method: string
  path: string
  query: Record<string, string[]>
  body: unknown
}

interface Scenario {
  ctx: AllegroContext
  /** What the connector sent, in both modes. */
  sent: Sent[]
  close(): Promise<void>
}

function queryOf(url: URL): Record<string, string[]> {
  const query: Record<string, string[]> = {}
  for (const [name, value] of url.searchParams) (query[name] ??= []).push(value)
  return query
}

/** A scenario cassette under `fixtures/sandbox/`: recorded from the sandbox with the saved seller, else replayed. */
async function openScenario(name: string): Promise<Scenario> {
  const live: { account?: RecordingAccount } = {}
  const cassette = await openCassette(new URL(`${name}.cassette.json`, fixtures), {
    scrub: allegroScrub,
    secrets: [credentials.accessToken, credentials.refreshToken, app.clientId, app.clientSecret],
    match: { exhausted: 'error' },
    recording: async () => {
      live.account = await loadRecordingAccount()
      return { fetch: tokenPersistingFetch(live.account.account), secrets: secretsOf(live.account) }
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
    ctx: { app: live.account?.app ?? app, config: {}, credentials: live.account?.credentials ?? credentials, fetch: spy, log: () => {} },
    sent,
    async close() {
      await cassette.close()
      expect(cassette.misses).toEqual([])
      expect(cassette.unused()).toEqual([])
    },
  }
}

const fullOrders = (items: Array<Order | OrderUpdate>) => items.filter((item): item is Order => !isOrderUpdate(item))
const ids = (items: Array<Order | OrderUpdate>) => items.map((item) => (isOrderUpdate(item) ? `update:${item.externalId}` : item.externalId))
const factTypes = (item: Order | OrderUpdate) => (item.facts ?? []).map((fact) => fact.type)

describe('allegro connector against sandbox recordings', () => {
  it(
    'passes the conformance kit (C1 to C18: refresh, device flow, journal, expired cursor) on real traffic',
    async () => {
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
        // C9 pushes 0 then 5 to the first three Offers (ending and reopening them), C10 sets every phase on the first
        // Order, C13 pushes 19.99 and then 25 to the first three Offers' prices, C15 rotates the seller's tokens
        // (persisted by the fetch), C16 starts a device sign-in nobody approves.
        recording: async () => {
          const real = await loadRecordingAccount()
          return {
            app: real.app,
            credentials: real.credentials,
            unauthorizedCredentials: { ...real.credentials, accessToken: 'bogus-revoked-token-value' },
            refusedRefreshCredentials: { ...real.credentials, refreshToken: 'bogus-refused-refresh-token' },
            fetch: tokenPersistingFetch(real.account),
            secrets: secretsOf(real),
          }
        },
      })
    },
    timeout,
  )

  it('keeps tokens, client credentials, Buyer and seller data out of every sandbox cassette', async () => {
    const names = (await readdir(fixtures)).sort()
    for (const name of [CONFORMANCE_CASSETTE, DEVICE_FLOW_CASSETTE, REFRESH_CASSETTE, REFRESH_REFUSED_CASSETTE, UNAUTHORIZED_CASSETTE]) {
      expect(names).toContain(name)
    }
    // Only where the seller's sign-in exists (never in CI): its real secrets must not be in any cassette either.
    const local = await loadRecordingAccount().then(secretsOf, () => [])
    const personal = [
      'Testowy',
      'Grunwaldzka',
      '500600700',
      'allegrogroup',
      'goldlightdrake',
      'Hanza Test Sp',
      '5252434812',
      'Client:111578773',
      'eyJ',
      'Bearer ',
      'Basic ',
    ]
    for (const name of names) {
      const text = await readFile(new URL(name, fixtures), 'utf8')
      for (const secret of local) expect(text, name).not.toContain(secret)
      for (const value of personal) expect(text, `${name} contains ${value}`).not.toContain(value)
    }
  })
})

describe('orders.updateStatus on the sandbox', () => {
  it(
    'sets the fulfillment status of a real form, and fails on an unknown one',
    async () => {
      const scenario = await openScenario('sandbox-orders-update-status')
      for (const phase of ['processing', 'shipped', 'new'] as const) {
        await updateStatus(scenario.ctx, { orderExternalId: forms.paidMugs, phase })
      }
      // A valid time UUID no form has: Allegro answers 422.
      const unknown = await updateStatus(scenario.ctx, { orderExternalId: '00000000-0000-11f1-904f-89bb34047197', phase: 'shipped' }).then(
        () => null,
        (error: unknown) => error,
      )
      await scenario.close()

      expect(scenario.sent.slice(0, 3)).toEqual(
        ['PROCESSING', 'SENT', 'NEW'].map((status) => ({
          method: 'PUT',
          path: `/order/checkout-forms/${forms.paidMugs}/fulfillment`,
          query: {},
          body: { status },
        })),
      )
      expect(unknown).toBeInstanceOf(PermanentError)
    },
    timeout,
  )
})

describe('offers.pull on the sandbox', () => {
  // C13 changed the first three Offers' prices.
  beforeAll(restorePrices, timeout)

  it(
    "lists the seller's five Offers newest first, looking up why only a sold-out-looking one ended",
    async () => {
      const scenario = await openScenario('sandbox-offers-pull')
      const page = await pullOffers(scenario.ctx, null)
      await scenario.close()

      const [listing, ...lookups] = scenario.sent
      expect(listing).toEqual({
        method: 'GET',
        path: '/sale/offers',
        query: { limit: ['1000'], offset: ['0'], 'publication.status': ['ACTIVE', 'ACTIVATING', 'ENDED'] },
        body: null,
      })
      expect(page).toMatchObject({ nextCursor: '5', hasMore: false })
      expect(page.items.map(({ externalId, sku, name, price, url }) => ({ externalId, sku, name, price, url }))).toEqual(
        [
          ['7782361660', 'HANZA-MUG-WHITE', 'Kubek ceramiczny Forma 300 ml - kremowy', '19.9'],
          ['7782361659', 'HANZA-MUG-WHITE', 'Kubek emaliowany niebieski 350 ml', '19.9'],
          ['7782361658', 'HANZA-PLATE-WHITE', 'Produkt 1 - Talerz porcelanowy biały', '24.0'],
          ['7782361657', 'HANZA-MUG-BLUE', 'Kubek niebieski ceramiczny', '34.5'],
          ['7782361656', 'HANZA-MUG-RED', 'Kubek czerwony ceramiczny', '39.99'],
        ].map(([externalId, sku, name, amount]) => ({
          externalId,
          sku,
          name,
          price: { amount, currency: 'PLN' },
          url: `https://allegro.pl.allegrosandbox.pl/oferta/${externalId}`,
        })),
      )
      // Statuses move with every push to these Offers, so only the rule: a detail lookup only for an ended Offer, and
      // an ended Offer without one ended with stock left (`other`).
      const looked = lookups.map(({ method, path }) => {
        expect(method).toBe('GET')
        return path.replace('/sale/product-offers/', '')
      })
      for (const offer of page.items) {
        if (looked.includes(offer.externalId)) expect(offer.status).toBe('ended')
        if (offer.status === 'ended' && !looked.includes(offer.externalId)) expect(offer.endedReason).toBe('other')
        if (offer.status === 'active') expect(offer.endedReason).toBeUndefined()
      }
      // Ended by the seller: whatever its stock, never sold out.
      expect(page.items[0]).toMatchObject({ status: 'ended', endedReason: 'other' })
    },
    timeout,
  )
})

describe('orders.pull on the sandbox', () => {
  // Recording only, sent outside any cassette: C10 leaves the first Order `CANCELLED`, and other runs on the same
  // account ship or cancel the forms, which the listing leaves out. The listing shows a fulfillment change some
  // seconds after the PUT answered 204 (seen on the sandbox), hence the wait.
  beforeAll(async () => {
    if (!recording) return
    const real = await loadRecordingAccount()
    const ctx: AllegroContext = { app: real.app, config: {}, credentials: real.credentials, fetch: tokenPersistingFetch(real.account), log: () => {} }
    for (const id of Object.values(forms)) await updateStatus(ctx, { orderExternalId: id, phase: 'new' })
    await waitForAllegro(10_000)
  }, timeout)

  const lines = {
    [forms.paidMugs]: { offerExternalId: '7782361656', sku: 'HANZA-MUG-RED', quantity: 2, unitPrice: { amount: '39.99', currency: 'PLN' } },
    [forms.unpaidMug]: { offerExternalId: '7782361657', sku: 'HANZA-MUG-BLUE', quantity: 1, unitPrice: { amount: '34.50', currency: 'PLN' } },
    [forms.paidPlate]: { offerExternalId: '7782361658', sku: 'HANZA-PLATE-WHITE', quantity: 1, unitPrice: { amount: '24.00', currency: 'PLN' } },
  }
  const totals = { [forms.paidMugs]: '85.97', [forms.unpaidMug]: '40.49', [forms.paidPlate]: '29.99' }

  function expectFullOrder(order: Order) {
    expect(order.lines).toEqual([expect.objectContaining(lines[order.externalId])])
    expect(order.total).toEqual({ amount: totals[order.externalId], currency: 'PLN' })
    if (order.externalId === forms.unpaidMug) {
      expect(order.awaitingPayment).toBe(true)
      expect(factTypes(order)).not.toContain('paid')
    } else {
      expect(order.awaitingPayment).toBe(false)
      expect(order.facts).toContainEqual(expect.objectContaining({ id: `${order.externalId}:paid`, type: 'paid' }))
    }
  }

  // Other runs place purchases on the same account: only the three known forms are asserted on, and an Order placed
  // between the two pulls may reach the journal.
  const known = (items: Array<Order | OrderUpdate>) => items.filter((item) => Object.values(forms).includes(item.externalId))

  it(
    'starts from null: the journal position, the three open Orders, then an empty journal',
    async () => {
      const scenario = await openScenario('sandbox-orders-first-pull')
      const first = await pullOrders(scenario.ctx, null)
      const second = await pullOrders(scenario.ctx, first.nextCursor)
      await scenario.close()

      expect(scenario.sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
        'GET /order/event-stats',
        'GET /order/checkout-forms',
        'GET /order/events',
      ])
      expect(first.hasMore).toBe(true)
      const cursor = decodeCursor(first.nextCursor!)
      expect(cursor).toMatchObject({ phase: 'journal', eventId: expect.stringMatching(/^\d+$/) })
      expect(BigInt(cursor.eventId!) > BigInt(FIRST_EVENT)).toBe(true)
      // The boundary is Allegro's `Date` of the event-stats answer: after the purchases.
      expect(Date.parse(cursor.boughtBefore)).toBeGreaterThan(Date.parse('2026-10-10T20:26:00.000Z'))
      expect(scenario.sent[2]!.query).toEqual({ from: [cursor.eventId], limit: ['100'] })

      expect(ids(known(first.items)).sort()).toEqual(Object.values(forms).sort())
      for (const order of fullOrders(known(first.items))) expectFullOrder(order)
      expect(known(second.items)).toEqual([])
      if (second.items.length === 0) expect(second).toEqual({ items: [], nextCursor: first.nextCursor, hasMore: false })
    },
    timeout,
  )

  it(
    'follows the journal: full Orders after the boundary (a paid one followed by its update), updates before it',
    async () => {
      const scenario = await openScenario('sandbox-orders-journal')
      const after = await pullOrders(scenario.ctx, encodeCursor({ phase: 'journal', eventId: FIRST_EVENT, boughtBefore: '2026-10-10T20:00:00.000Z' }))
      const before = await pullOrders(scenario.ctx, encodeCursor({ phase: 'journal', eventId: FIRST_EVENT, boughtBefore: '2026-10-10T20:30:00.000Z' }))
      await scenario.close()

      expect(scenario.sent[0]).toMatchObject({ method: 'GET', path: '/order/events', query: { from: [FIRST_EVENT], limit: ['100'] } })
      // `from` is exclusive: the first BOUGHT is not on the page, its form comes back through its later events.
      expect(ids(known(after.items)).sort()).toEqual(
        [forms.paidMugs, `update:${forms.paidMugs}`, forms.unpaidMug, forms.paidPlate, `update:${forms.paidPlate}`].sort(),
      )
      expect(ids(after.items).indexOf(`update:${forms.paidMugs}`)).toBe(ids(after.items).indexOf(forms.paidMugs) + 1)
      expect(ids(after.items).indexOf(`update:${forms.paidPlate}`)).toBe(ids(after.items).indexOf(forms.paidPlate) + 1)
      for (const order of fullOrders(known(after.items))) expectFullOrder(order)
      for (const update of known(after.items).filter(isOrderUpdate)) {
        expect(factTypes(update)).toContain('paid')
        expect(update.shippingAddress).toMatchObject({ countryCode: 'PL' })
      }

      expect(ids(known(before.items)).sort()).toEqual(Object.values(forms).map((id) => `update:${id}`).sort())
      for (const update of known(before.items).filter(isOrderUpdate)) {
        if (update.externalId === forms.unpaidMug) expect(factTypes(update)).not.toContain('paid')
        else expect(update.facts).toContainEqual(expect.objectContaining({ id: `${update.externalId}:paid`, type: 'paid' }))
      }
      expect(decodeCursor(after.nextCursor!)).toMatchObject({ phase: 'journal', boughtBefore: '2026-10-10T20:00:00.000Z' })
      expect(decodeCursor(before.nextCursor!)).toMatchObject({ phase: 'journal', boughtBefore: '2026-10-10T20:30:00.000Z' })
    },
    timeout,
  )
})

describe('stock.push on the sandbox', () => {
  it(
    'ends an Offer at 0, reopens it above 0, and rejects one ended by the seller and an unknown one',
    async () => {
      const scenario = await openScenario('sandbox-stock-push')
      const ended = await pushStock(scenario.ctx, [{ offerExternalId: '7782361659', sku: 'HANZA-MUG-WHITE', available: 0 }])
      const sentForZero = scenario.sent.length
      await waitForAllegro(8000)
      const reopened = await pushStock(scenario.ctx, [
        { offerExternalId: '7782361659', sku: 'HANZA-MUG-WHITE', available: 3 },
        { offerExternalId: '7782361660', sku: 'HANZA-MUG-WHITE', available: 5 },
        { offerExternalId: '1234567890', sku: null, available: 1 },
      ])
      await scenario.close()

      expect(ended).toEqual([{ offerExternalId: '7782361659', outcome: 'ended' }])
      expect(scenario.sent.slice(0, sentForZero)).toEqual([
        { method: 'PATCH', path: '/sale/product-offers/7782361659', query: {}, body: { stock: { available: 0 } } },
      ])
      expect(reopened).toEqual([
        { offerExternalId: '7782361659', outcome: 'ok' },
        { offerExternalId: '7782361660', outcome: 'rejected', code: 'OFFER_ENDED_USER' },
        { offerExternalId: '1234567890', outcome: 'rejected', code: 'OFFER_NOT_FOUND' },
      ])
      // Ended by the 0 by then (`EMPTY_STOCK`): the stock, then the reopen.
      const patches = scenario.sent.slice(sentForZero).map(({ path, body }) => `${path.split('/').at(-1)} ${JSON.stringify(body)}`)
      expect(patches.filter((patch) => patch.startsWith('7782361659'))).toEqual([
        '7782361659 {"stock":{"available":3}}',
        '7782361659 {"publication":{"status":"ACTIVE"}}',
      ])
      expect(patches.filter((patch) => !patch.startsWith('7782361659')).sort()).toEqual([
        '1234567890 {"stock":{"available":1}}',
        '7782361660 {"stock":{"available":5}}',
      ])
    },
    timeout,
  )
})

describe('price.push on the sandbox', () => {
  // Back to 19.90 for the next run's `sandbox-offers-pull`.
  afterAll(restorePrices, timeout)

  it(
    'sets a price as sent, and rejects a currency the marketplace does not use and an unknown Offer',
    async () => {
      const scenario = await openScenario('sandbox-price-push')
      const set = await pushPrices(scenario.ctx, [
        { offerExternalId: '7782361659', sku: 'HANZA-MUG-WHITE', price: { amount: '21.50', currency: 'PLN' } },
        { offerExternalId: '1234567890', sku: null, price: { amount: '21.50', currency: 'PLN' } },
      ])
      // A call of its own: two edits of one Offer in flight at once could meet each other.
      const euro = await pushPrices(scenario.ctx, [{ offerExternalId: '7782361659', sku: 'HANZA-MUG-WHITE', price: { amount: '21.50', currency: 'EUR' } }])
      // The listing shows a new price some seconds after the edit answered.
      await waitForAllegro(10_000)
      const listed = await pullOffers(scenario.ctx, null)
      await scenario.close()

      expect(set).toEqual([
        { offerExternalId: '7782361659', outcome: 'ok' },
        { offerExternalId: '1234567890', outcome: 'rejected', code: 'OFFER_NOT_FOUND' },
      ])
      // Allegro's code is `IncorrectBaseCurrency` (2026-10-10); only its shape is held here.
      expect(euro).toEqual([{ offerExternalId: '7782361659', outcome: 'rejected', code: expect.stringMatching(/^[A-Za-z0-9_.:-]{1,100}$/) }])
      const patches = scenario.sent.filter(({ method }) => method === 'PATCH').map(({ path, body }) => `${path.split('/').at(-1)} ${JSON.stringify(body)}`)
      expect(patches.slice(0, 2).sort()).toEqual([
        '1234567890 {"sellingMode":{"price":{"amount":"21.50","currency":"PLN"}}}',
        '7782361659 {"sellingMode":{"price":{"amount":"21.50","currency":"PLN"}}}',
      ])
      expect(patches[2]).toBe('7782361659 {"sellingMode":{"price":{"amount":"21.50","currency":"EUR"}}}')
      // The EUR edit changed nothing; the listing writes the new price as a double.
      expect(listed.items.find(({ externalId }) => externalId === '7782361659')?.price).toEqual({ amount: '21.5', currency: 'PLN' })
    },
    timeout,
  )
})
