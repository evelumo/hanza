import { readFile } from 'node:fs/promises'
import { allegroConnector, type AllegroCredentials } from '@hanza/connector-allegro'
import {
  allegroScrub,
  createFakeAllegroApi,
  FAKE_ALLEGRO_NOW,
  offers as sampleOffers,
  sampleCheckoutForm,
  sampleListingOffer,
  type CheckoutFormPayload,
  type FakeAllegroApi,
} from '@hanza/connector-allegro/testing'
import { openCassette, withFetch, type OpenedCassette } from '@hanza/connector-sdk/testing'
import {
  changeOrderStatus,
  coalesceKeys,
  createConnection,
  createProduct,
  getAvailability,
  getOrder,
  jobs,
  openConnection,
  ordersPullRef,
  PermanentJobError,
  requestSync,
  setStock,
  type Actor,
} from '@hanza/core'
import { createTestContext, createTestOrganization, type TestContext } from '@hanza/core/testing'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'

const databaseUrl = inject('hanzaTestDatabaseUrl')
const user: Actor = { type: 'user', userId: 'user-1' }
const cassetteFile = new URL('./fixtures/allegro-engine.cassette.json', import.meta.url)

// The installation settings of the operator's registered application; the simulation checks the same pair.
const app = { clientId: 'hanza-test-client-id', clientSecret: 'hanza-test-client-secret' }
const settings = {
  HANZA_CONNECTOR_ALLEGRO_CLIENT_ID: app.clientId,
  HANZA_CONNECTOR_ALLEGRO_CLIENT_SECRET: app.clientSecret,
  HANZA_CONNECTOR_ALLEGRO_ENVIRONMENT: 'sandbox',
  HANZA_CONNECTOR_ALLEGRO_APP_NAME: 'Hanza Test',
}

// The feed's boundary is the `Date` of Allegro's event-stats answer, which the simulation (and so the cassette) gives
// as its fixed data clock: START. Sample Orders were bought before it. The local clock starts there too and is moved
// on by the steps, so the access token expires at the same point in recording and replay.
const START = Date.parse(FAKE_ALLEGRO_NOW)
const HOUR = 3_600_000
const iso = (time: number) => new Date(time).toISOString()

// What the replay stores in place of a signed-in seller's tokens; scrubbed before matching, like the recorded ones.
const replayCredentials: AllegroCredentials = {
  accessToken: 'replay-access-token',
  refreshToken: 'replay-refresh-token',
  accessTokenExpiresAt: iso(START + 12 * HOUR),
}

const SKU = { mug: 'MUG-350-WHT', teapot: 'TEAPOT-1L-BLU', cup: 'CUP-090-BLK', bowl: 'BOWL-240-GRY' } as const
const OFFER = { mug: '7834566001', teapot: '7834566002', cup: '7834566004', bowl: '7834566005', noSku: '7834566006' } as const

// The seller's Offers on Allegro: two active, one ended when it sold out, one the seller ended, one without a SKU, a
// One Fulfillment one (skipped) and a draft (not listed).
const offers = [
  sampleOffers.buyNow,
  sampleListingOffer({ id: OFFER.teapot, name: 'Teapot 1 l, blue glaze', external: { id: SKU.teapot }, stock: { available: 7 } }),
  sampleOffers.endedSoldOut,
  sampleOffers.endedByUser,
  sampleOffers.withoutSignature,
  sampleOffers.oneFulfillment,
  sampleOffers.draft,
]

const formId = (suffix: string) => `5c0e7a12-c4ec-11f1-9e21-0a1b2c3d${suffix}`
const FORM = { paid: formId('e001'), unpaid: formId('e002'), toCancel: formId('e003'), shippedBefore: formId('e004'), placedLater: formId('e005') } as const

function line(id: string, offer: 'mug' | 'teapot', quantity: number, boughtAt: string) {
  const name = offer === 'mug' ? 'Ceramic mug 350 ml, white' : 'Teapot 1 l, blue glaze'
  const amount = offer === 'mug' ? '39.99' : '119.90'
  return {
    id: `62ae358b-c4e8-11f1-9c77-${id}`,
    offer: { id: OFFER[offer], name, external: { id: SKU[offer] } },
    quantity,
    originalPrice: { amount, currency: 'PLN' },
    price: { amount, currency: 'PLN' },
    boughtAt,
  }
}

const pln = (amount: string) => ({ amount, currency: 'PLN' })
const base = sampleCheckoutForm()
const ewaDelivery = {
  firstName: 'Ewa',
  lastName: 'Nowak',
  street: 'Garbary 5',
  city: 'Poznań',
  zipCode: '61-757',
  countryCode: 'PL',
  phoneNumber: '+48 600 000 002',
}

// On Allegro before the Connection: a paid Order, an unpaid one (no delivery address yet: the Buyer's account address
// stands in), one the Buyer will cancel, and one shipped before Hanza was connected.
const forms: Record<'paid' | 'unpaid' | 'toCancel' | 'shippedBefore', CheckoutFormPayload> = {
  paid: sampleCheckoutForm({
    id: FORM.paid,
    lineItems: [line('5a0000000001', 'mug', 2, '2026-10-01T09:00:00.000Z')],
    summary: { totalToPay: pln('94.97') },
    updatedAt: '2026-10-01T09:10:05.000Z',
  }),
  unpaid: sampleCheckoutForm({
    id: FORM.unpaid,
    status: 'FILLED_IN',
    payment: { type: 'ONLINE' },
    delivery: null,
    lineItems: [line('5a0000000002', 'teapot', 1, '2026-10-01T09:30:00.000Z')],
    summary: { totalToPay: pln('134.89') },
    updatedAt: '2026-10-01T09:31:00.000Z',
  }),
  toCancel: sampleCheckoutForm({
    id: FORM.toCancel,
    payment: { type: 'ONLINE', finishedAt: '2026-10-02T10:05:00.000Z' },
    lineItems: [line('5a0000000003', 'mug', 1, '2026-10-02T10:00:00.000Z')],
    summary: { totalToPay: pln('54.98') },
    updatedAt: '2026-10-02T10:05:00.000Z',
  }),
  shippedBefore: sampleCheckoutForm({
    id: FORM.shippedBefore,
    fulfillment: { status: 'SENT', provider: { id: 'SELLER' } },
    payment: { type: 'ONLINE', finishedAt: '2026-09-28T08:05:00.000Z' },
    lineItems: [line('5a0000000004', 'mug', 4, '2026-09-28T08:00:00.000Z')],
    summary: { totalToPay: pln('174.95') },
    updatedAt: '2026-09-29T14:00:00.000Z',
  }),
}

interface Sent {
  method: string
  path: string
  body: unknown
  /** In memory only, to prove a rotated token replaced the old one; never written anywhere. */
  authorization: string | null
}

// The engine runs the Allegro connector on a recorded cassette: no network. The cassette is recorded from the in-memory
// simulation of the Allegro API (`@hanza/connector-allegro/testing`), not the sandbox: record it again with
// `HANZA_RECORD_FIXTURES=1 pnpm --filter @hanza/worker exec vitest run src/allegro.db.test.ts`, then read the diff.
// The steps run in order and share one Connection; `script` changes the simulation between them while recording.
describe.skipIf(!databaseUrl)('Allegro through the engine (real Postgres, in-memory queue, replayed Allegro API)', () => {
  let ctx: TestContext
  let cassette: OpenedCassette
  let org: string
  let connectionId: string
  let signedIn: AllegroCredentials
  let closed = false
  const live: { api?: FakeAllegroApi } = {}
  const products: Record<keyof typeof SKU, string> = { mug: '', teapot: '', cup: '', bowl: '' }
  const sent: Sent[] = []
  let accountStreet = ''

  /** Changes the simulation between two steps; a no-op on replay, where the cassette already holds the outcome. */
  const script = (change: (api: FakeAllegroApi) => void) => {
    if (live.api) change(live.api)
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: START, shouldAdvanceTime: true })
    cassette = await openCassette(cassetteFile, {
      scrub: allegroScrub,
      // The engine must make exactly the recorded calls: a repeated push would be a bug, not a replay detail.
      match: { exhausted: 'error' },
      secrets: [replayCredentials.accessToken, replayCredentials.refreshToken, app.clientId, app.clientSecret],
      recording: () => {
        // The simulation's own writes (Hanza's fulfilment updates) carry its fixed data clock, which is START.
        const api = createFakeAllegroApi({ ...app, offers, forms: Object.values(forms) })
        live.api = api
        signedIn = api.signIn()
        return { fetch: api.fetch, secrets: [signedIn.accessToken, signedIn.refreshToken] }
      },
    })
    signedIn ??= replayCredentials
    const spy: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      const text = await request.clone().text()
      const json = text !== '' && request.headers.get('content-type')?.includes('json')
      sent.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: json ? JSON.parse(text) : null,
        authorization: request.headers.get('authorization'),
      })
      return cassette.fetch(request)
    }
    ctx = createTestContext({ databaseUrl: databaseUrl!, connectors: [withFetch(allegroConnector, spy)], connectorSettings: settings })
    org = await createTestOrganization(ctx.db)
  })

  afterAll(async () => {
    if (!closed) await cassette?.close()
    vi.useRealTimers()
    await ctx?.db.$disconnect()
  })

  /** Only this organization's jobs: the test database is shared with other files. */
  async function drain() {
    const own = ctx.queue.waiting.filter((job) => (job.payload as { organizationId?: string }).organizationId === org)
    ctx.queue.waiting.splice(0, ctx.queue.waiting.length, ...own)
    const result = await ctx.queue.drain(ctx, jobs)
    expect(result.failed).toEqual([])
    expect(ctx.queue.waiting).toEqual([])
  }

  async function pullOrders() {
    await ctx.queue.enqueue(ordersPullRef, { organizationId: org, connectionId, trigger: 'schedule' }, { coalesceKey: coalesceKeys.ordersPull(connectionId) })
  }

  const requests = (from: number) => sent.slice(from).map(({ method, path }) => `${method} ${path}`)
  const writes = (from: number) =>
    sent
      .slice(from)
      .filter(({ method }) => method === 'PATCH' || method === 'PUT')
      .map(({ method, path, body }) => `${method} ${path} ${JSON.stringify(body)}`)
      .sort()

  const order = async (externalId: string) => {
    const row = await ctx.db.order.findFirstOrThrow({ where: { organizationId: org, connectionId, externalId } })
    return (await getOrder(ctx, org, row.id))!
  }
  const reservations = async (externalId: string) => {
    const row = await ctx.db.order.findFirstOrThrow({
      where: { organizationId: org, connectionId, externalId },
      include: { lines: { orderBy: { externalId: 'asc' }, include: { reservation: true } } },
    })
    return row.lines.map((orderLine) => [orderLine.reservation?.status, orderLine.reservation?.units])
  }
  const importedIds = async () =>
    (await ctx.db.order.findMany({ where: { organizationId: org, connectionId }, orderBy: { externalId: 'asc' } })).map((row) => row.externalId)
  const available = async (product: keyof typeof SKU) => (await getAvailability(ctx.db, org, [products[product]])).get(products[product])!
  const offer = (externalId: string) => ctx.db.offer.findFirstOrThrow({ where: { organizationId: org, connectionId, externalId } })
  const connection = () => ctx.db.connection.findFirstOrThrow({ where: { id: connectionId, organizationId: org } })
  const feedState = () => ctx.db.syncState.findFirstOrThrow({ where: { organizationId: org, connectionId, stream: 'orders_pull' } })
  /** The ids of the organization's Events so far, to tell the ones a step wrote. */
  const eventMark = async () => new Set((await ctx.db.eventLog.findMany({ where: { organizationId: org }, select: { id: true } })).map(({ id }) => id))
  const eventsAfter = async (mark: Set<string>) =>
    (await ctx.db.eventLog.findMany({ where: { organizationId: org }, orderBy: { id: 'asc' } })).filter(({ id }) => !mark.has(id))

  it('1. the first sync imports the Offers and only the Orders open on Allegro, and reserves their units', async () => {
    for (const [key, stock] of [['mug', 10], ['teapot', 6], ['cup', 0], ['bowl', 3]] as const) {
      products[key] = (await createProduct(ctx, org, { sku: SKU[key], name: SKU[key], stock }, user)).productId
    }
    // As if the seller had just signed in through the device flow: the core seals what the sign-in returned.
    connectionId = (
      await createConnection(
        ctx,
        org,
        {
          connectorId: 'allegro',
          name: 'Allegro sandbox',
          config: {},
          credentials: signedIn,
          credentialsExpireAt: new Date(signedIn.accessTokenExpiresAt),
          account: { id: '43784832', label: 'hanza-sandbox-seller' },
        },
        user,
      )
    ).connectionId
    const stored = await connection()
    expect(stored.credentials).not.toContain(signedIn.refreshToken)
    await requestSync(ctx, org, connectionId)
    await drain()

    expect((await connection()).health).toBe('ok')
    const rows = await ctx.db.offer.findMany({ where: { organizationId: org, connectionId }, orderBy: { externalId: 'asc' } })
    expect(rows.map((row) => [row.externalId, row.productId, row.channelStatus, row.channelEndedReason])).toEqual([
      [OFFER.mug, products.mug, 'active', null],
      [OFFER.teapot, products.teapot, 'active', null],
      [OFFER.cup, products.cup, 'ended', 'sold_out'],
      [OFFER.bowl, products.bowl, 'ended', 'other'],
      [OFFER.noSku, null, 'active', null],
    ])

    // The paid, the unpaid and the soon cancelled one; never the one shipped before the Connection.
    expect(await importedIds()).toEqual([FORM.paid, FORM.unpaid, FORM.toCancel].sort())
    const paid = await order(FORM.paid)
    expect(paid).toMatchObject({ phase: 'new', awaitingPayment: false })
    // Awaiting payment, shipped to the Buyer's account address for now (the same street as the paid Order's delivery;
    // compared as stored, since a replay holds the scrubbed values).
    const unpaid = await order(FORM.unpaid)
    expect(unpaid).toMatchObject({ phase: 'new', awaitingPayment: true })
    const { street, postalCode, city, countryCode } = paid.shippingAddress!
    expect(unpaid.shippingAddress).toMatchObject({ street, postalCode, city, countryCode: 'PL' })
    expect(countryCode).toBe('PL')
    accountStreet = street
    expect(await reservations(FORM.paid)).toEqual([['open', 2]])
    expect(await reservations(FORM.unpaid)).toEqual([['open', 1]])
    expect(await available('mug')).toEqual({ stock: 10, reserved: 3, available: 7 })
    expect(await available('teapot')).toEqual({ stock: 6, reserved: 1, available: 5 })

    // The last number each Offer was told is Channel Available; the ended Offers were never pushed to.
    expect((await offer(OFFER.mug)).lastPushedAvailable).toBe(7)
    expect((await offer(OFFER.teapot)).lastPushedAvailable).toBe(5)
    expect(sent.filter(({ path }) => path.endsWith(OFFER.cup) || path.endsWith(OFFER.bowl)).map(({ method }) => method)).toEqual(['GET'])
    expect((await offer(OFFER.bowl)).stockRejectedCode).not.toBeNull()

    const feed = await feedState()
    expect(feed.cursor).toMatch(/^e1:/)
    expect(requests(0).filter((request) => request.startsWith('GET /order'))).toEqual([
      'GET /order/event-stats',
      'GET /order/checkout-forms',
      'GET /order/events',
    ])
  })

  it('2. a Stock change pushes the real number with one PATCH per Offer; 0 ends the Offer, a number above 0 reopens it', async () => {
    let mark = sent.length
    await setStock(ctx, org, products.mug, 12, user)
    await setStock(ctx, org, products.teapot, 9, user)
    await drain()
    expect(writes(mark)).toEqual([
      `PATCH /sale/product-offers/${OFFER.mug} {"stock":{"available":9}}`,
      `PATCH /sale/product-offers/${OFFER.teapot} {"stock":{"available":8}}`,
    ])

    mark = sent.length
    let events = await eventMark()
    await setStock(ctx, org, products.mug, 3, user)
    await drain()
    expect(writes(mark)).toEqual([`PATCH /sale/product-offers/${OFFER.mug} {"stock":{"available":0}}`])
    expect(await offer(OFFER.mug)).toMatchObject({ channelStatus: 'ended', channelEndedReason: 'sold_out', lastPushedAvailable: 0 })
    expect((await eventsAfter(events)).filter((event) => event.type === 'offer.channel_status_changed').map((event) => event.subjectId)).toEqual([
      (await offer(OFFER.mug)).id,
    ])

    mark = sent.length
    events = await eventMark()
    await setStock(ctx, org, products.mug, 8, user)
    await setStock(ctx, org, products.cup, 4, user)
    await drain()
    expect(writes(mark)).toEqual([
      `PATCH /sale/product-offers/${OFFER.mug} {"publication":{"status":"ACTIVE"}}`,
      `PATCH /sale/product-offers/${OFFER.mug} {"stock":{"available":5}}`,
      `PATCH /sale/product-offers/${OFFER.cup} {"publication":{"status":"ACTIVE"}}`,
      `PATCH /sale/product-offers/${OFFER.cup} {"stock":{"available":4}}`,
    ])
    for (const [externalId, number] of [[OFFER.mug, 5], [OFFER.cup, 4]] as const) {
      expect(await offer(externalId)).toMatchObject({ channelStatus: 'active', channelEndedReason: null, lastPushedAvailable: number })
    }
    expect((await eventsAfter(events)).filter((event) => event.type === 'offer.channel_status_changed')).toHaveLength(2)
    // The Offer the seller ended stays ended: never pushed to.
    expect(sent.some(({ method, path }) => method === 'PATCH' && path.endsWith(OFFER.bowl))).toBe(false)
  })

  it('3. a phase change in Hanza pushes the fulfilment status through the outbox', async () => {
    const paid = await order(FORM.paid)
    let mark = sent.length
    await changeOrderStatus(ctx, org, paid.id, 'processing', user)
    await drain()
    expect(sent.slice(mark).filter(({ method }) => method === 'PUT').map(({ path, body }) => [path, body])).toEqual([
      [`/order/checkout-forms/${FORM.paid}/fulfillment`, { status: 'PROCESSING' }],
    ])

    mark = sent.length
    await changeOrderStatus(ctx, org, paid.id, 'shipped', user)
    await drain()
    expect(sent.slice(mark).filter(({ method }) => method === 'PUT').map(({ path, body }) => [path, body])).toEqual([
      [`/order/checkout-forms/${FORM.paid}/fulfillment`, { status: 'SENT' }],
    ])
    const row = await ctx.db.order.findFirstOrThrow({ where: { organizationId: org, id: paid.id } })
    expect(row).toMatchObject({ phase: 'shipped', statusPushDueAt: null })
    expect(await reservations(FORM.paid)).toEqual([['consumed', 2]])
    expect(await available('mug')).toEqual({ stock: 6, reserved: 1, available: 5 })
  })

  it('4. a journal page brings a new Order in full, a payment, a cancellation, the shipping echo and an update for an Order never imported', async () => {
    vi.setSystemTime(START + 2 * HOUR)
    script((api) => {
      // Placed after the feed's boundary: sent in full (and, being paid, as an update with its addresses).
      api.setForm(
        sampleCheckoutForm({
          id: FORM.placedLater,
          buyer: { ...base.buyer, firstName: 'Ewa', lastName: 'Nowak', email: 'ewa.nowak@example.com', login: 'ewa_n_test' },
          delivery: { address: ewaDelivery },
          payment: { type: 'ONLINE', finishedAt: iso(START + HOUR + 60_000) },
          lineItems: [line('5a0000000005', 'teapot', 2, iso(START + HOUR))],
          summary: { totalToPay: pln('254.79') },
          updatedAt: iso(START + HOUR + 60_000),
        }),
      )
      api.addEvent('READY_FOR_PROCESSING', FORM.placedLater, iso(START + HOUR + 60_000))
      // The unpaid Order is paid; the delivery address appears with the payment.
      api.setForm({
        ...forms.unpaid,
        status: 'READY_FOR_PROCESSING',
        payment: { type: 'ONLINE', finishedAt: iso(START + HOUR + 120_000) },
        delivery: { address: ewaDelivery },
        updatedAt: iso(START + HOUR + 120_000),
      })
      api.addEvent('READY_FOR_PROCESSING', FORM.unpaid, iso(START + HOUR + 120_000))
      api.setForm({ ...forms.toCancel, status: 'CANCELLED', updatedAt: iso(START + HOUR + 180_000) })
      api.addEvent('BUYER_CANCELLED', FORM.toCancel, iso(START + HOUR + 180_000))
      // Shipped before the Connection, picked up now: Allegro journals it, Hanza never imported it.
      api.setForm({ ...forms.shippedBefore, fulfillment: { status: 'PICKED_UP', provider: { id: 'SELLER' } }, updatedAt: iso(START + HOUR + 240_000) })
      api.addEvent('FULFILLMENT_STATUS_CHANGED', FORM.shippedBefore, iso(START + HOUR + 240_000))
    })
    const mark = sent.length
    const before = await eventMark()
    await pullOrders()
    await drain()

    // The shipping echo of step 3 comes first in the journal; each form is read once.
    expect(requests(mark).filter((request) => request.startsWith('GET /order')).sort()).toEqual(
      [
        'GET /order/events',
        ...[FORM.paid, FORM.placedLater, FORM.unpaid, FORM.toCancel, FORM.shippedBefore].map((id) => `GET /order/checkout-forms/${id}`),
      ].sort(),
    )
    expect(await importedIds()).toEqual([FORM.paid, FORM.unpaid, FORM.toCancel, FORM.placedLater].sort())

    const placedLater = await order(FORM.placedLater)
    expect(placedLater).toMatchObject({ phase: 'new', awaitingPayment: false })
    expect(await reservations(FORM.placedLater)).toEqual([['open', 2]])

    // Paid, with the delivery address the payment brought (the new Order's, delivered to the same place).
    const paid = await order(FORM.unpaid)
    expect(paid).toMatchObject({ phase: 'new', awaitingPayment: false })
    const { street, postalCode, city } = placedLater.shippingAddress!
    expect(paid.shippingAddress).toMatchObject({ street, postalCode, city })
    expect(street).not.toBe(accountStreet)
    const paidEvents = (await eventsAfter(before)).filter((event) => event.subjectId === paid.id).map((event) => event.type)
    expect(paidEvents).toEqual(['order.channel_fact_recorded', 'order.payment_received', 'order.addresses_updated'])
    // Sealed: the new address is in no column or Event in clear.
    const raw = await ctx.db.order.findFirstOrThrow({ where: { organizationId: org, id: paid.id } })
    expect(JSON.stringify([raw, await eventsAfter(before)])).not.toContain(street)

    expect(await order(FORM.toCancel)).toMatchObject({ phase: 'cancelled' })
    expect(await reservations(FORM.toCancel)).toEqual([['released', 1]])

    // The echo of Hanza's own SENT changes nothing, and nothing is pushed back.
    const shipped = await order(FORM.paid)
    expect(shipped.phase).toBe('shipped')
    expect(sent.slice(mark).some(({ method }) => method === 'PUT')).toBe(false)

    expect(await ctx.db.order.count({ where: { organizationId: org, externalId: FORM.shippedBefore } })).toBe(0)
    // Six items: the new Order comes in full and then as an update with its addresses (a paid form after the boundary).
    expect((await feedState()).lastResult).toMatchObject({ pulled: 6, imported: 1, pages: 1, updatesIgnored: 1 })

    expect(await available('mug')).toEqual({ stock: 6, reserved: 0, available: 6 })
    expect(await available('teapot')).toEqual({ stock: 9, reserved: 3, available: 6 })
    expect(writes(mark)).toEqual([
      `PATCH /sale/product-offers/${OFFER.mug} {"stock":{"available":6}}`,
      `PATCH /sale/product-offers/${OFFER.teapot} {"stock":{"available":6}}`,
    ])
  })

  it('5. an access token about to expire is refreshed once under the lock, the rotated pair is stored, and the run goes on', async () => {
    const before = await openConnection(ctx, org, connectionId)
    const old = before!.credentials as AllegroCredentials
    expect(before!.credentialsVersion).toBe(0)
    vi.setSystemTime(START + 13 * HOUR)
    const mark = sent.length
    await pullOrders()
    await drain()

    expect(requests(mark)).toEqual(['POST /auth/oauth/token', 'GET /order/events'])
    expect(sent.slice(mark + 1).every(({ authorization }) => authorization !== `Bearer ${old.accessToken}`)).toBe(true)
    const after = await openConnection(ctx, org, connectionId)
    const rotated = after!.credentials as AllegroCredentials
    expect(after).toMatchObject({ credentialsVersion: 1, health: 'ok' })
    expect(rotated.refreshToken).not.toBe(old.refreshToken)
    expect(Date.parse(rotated.accessTokenExpiresAt)).toBeGreaterThan(START + 13 * HOUR)
    expect((await connection()).credentialsExpireAt?.toISOString()).toBe(new Date(rotated.accessTokenExpiresAt).toISOString())
  })

  it('6. running everything again changes nothing', async () => {
    const mark = sent.length
    const events = await eventMark()
    const orders = await ctx.db.order.findMany({ where: { organizationId: org }, orderBy: { id: 'asc' } })
    const offerRows = await ctx.db.offer.findMany({ where: { organizationId: org }, orderBy: { id: 'asc' } })
    await requestSync(ctx, org, connectionId)
    await drain()

    expect(requests(mark).sort()).toEqual(['GET /order/events', 'GET /sale/offers'])
    expect((await eventsAfter(events)).map((event) => event.type)).toEqual([])
    expect(await ctx.db.order.findMany({ where: { organizationId: org }, orderBy: { id: 'asc' } })).toEqual(orders)
    expect(
      (await ctx.db.offer.findMany({ where: { organizationId: org }, orderBy: { id: 'asc' } })).map(({ lastSeenAt, updatedAt, ...rest }) => rest),
    ).toEqual(offerRows.map(({ lastSeenAt, updatedAt, ...rest }) => rest))
  })

  it('7. a refused refresh (the seller unlinked the application) marks the Connection auth_expired', async () => {
    script((api) => api.revokeTokens())
    vi.setSystemTime(START + 26 * HOUR)
    const mark = sent.length
    await pullOrders()
    const result = await ctx.queue.drain(ctx, jobs)

    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]).toMatchObject({ attempts: 1 })
    expect(result.failed[0]!.error).toBeInstanceOf(PermanentJobError)
    expect(requests(mark)).toEqual(['POST /auth/oauth/token'])
    expect((await connection()).health).toBe('auth_expired')
    expect(await feedState()).toMatchObject({ lastErrorKind: 'auth_expired', lastError: '400 invalid_grant' })
  })

  it('served every recorded interaction and nothing else', () => {
    expect(cassette.misses).toEqual([])
    expect(cassette.unused()).toEqual([])
  })

  it('keeps tokens, client credentials and Buyer data out of the cassette', async () => {
    // Recording writes the file here, so the check below reads what is committed.
    await cassette.close()
    closed = true
    const text = await readFile(cassetteFile, 'utf8')
    for (const secret of [app.clientId, app.clientSecret, signedIn.accessToken, signedIn.refreshToken, ...(live.api?.issuedTokens ?? [])]) {
      expect(text).not.toContain(secret)
    }
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{4,}\./)
    expect(text.toLowerCase()).not.toContain('bearer ')
    expect(text.toLowerCase()).not.toContain('basic ')
    for (const personal of ['44051401359', '90010112345', 'Kowalska', 'Nowak', 'Półwiejska', 'Garbary', '61-888', '61-757', 'anna_k_test', 'ewa_n_test', 'gift']) {
      expect(text, `contains ${personal}`).not.toContain(personal)
    }
  })
})
