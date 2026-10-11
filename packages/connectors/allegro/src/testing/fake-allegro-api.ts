// Test and recording tooling only (`@hanza/connector-allegro/testing`): never imported by the connector itself.
// A simulation of the part of the Allegro REST API the connector uses, written from the OpenAPI file
// (developer.allegro.pl/swagger.yaml) and the tutorials, then corrected where the sandbox answered otherwise on
// 2026-10-10 (see "Fixtures" in the package's AGENTS.md). It answers as a `fetch`, in memory.
import { environmentHosts, type AllegroCredentials, type AllegroEnvironment } from '../settings'
import { forms as sampleForms, offers as sampleOffers, productOffers, type CheckoutFormPayload, type ListingOfferPayload } from './samples'

const PUBLIC_JSON = 'application/vnd.allegro.public.v1+json'
const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const ACCESS_TOKEN_SECONDS = 43_199
const DEVICE_CODE_SECONDS = 3600
// The tutorial's grace period for a rotated refresh token (the sandbox still took one right after the rotation).
const REFRESH_GRACE_MS = 60_000
// `from` of `GET /order/events` is a Java long.
const MAX_EVENT_ID = 9_223_372_036_854_775_807n
// Checkout form ids are time-based UUIDs (version 1); the API refuses any other id with 422.
const TIME_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-1[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SELLER = { id: '43784832', login: 'hanza-sandbox-seller' }
// A valid-looking PESEL (the documented example number, an invented person): the recording must scrub it.
const PESEL_LIKE = '44051401359'
/** The data clock: every time the simulation writes (an edit, a new event) unless a test sets its own. */
export const FAKE_ALLEGRO_NOW = '2026-10-10T12:00:00.000Z'

// A buy-now price: at most two decimals (`19.999` answers 422 `VALIDATION_ERROR` on the sandbox).
const PRICE_AMOUNT = /^\d{1,15}(\.\d{1,2})?$/
// The lowest price the sandbox took on allegro.pl ("Price must be equal to or higher than 1.00 PLN").
const MIN_PRICE = 1

// The statuses a seller may set (`RETURNED` is Allegro's own).
const SELLER_FULFILLMENT_STATUSES = ['NEW', 'PROCESSING', 'READY_FOR_SHIPMENT', 'READY_FOR_PICKUP', 'SENT', 'PICKED_UP', 'CANCELLED', 'SUSPENDED']

export interface FakeAllegroOffer {
  /** The Offer as `GET /sale/offers` lists it; `stock.available` and `publication.status` are kept current. */
  listing: ListingOfferPayload
  /** `publication.endedBy`, which only `GET /sale/product-offers/{id}` shows. */
  endedBy: string | null
  /**
   * The price as the product-offer resource shows it once one was set: with two decimals (`25` → `25.00`), while the
   * listing writes it as a double (`19.9`, `25.0`), both seen on the sandbox. Unset: the listing's.
   */
  price?: { amount: string; currency: string }
}

export interface FakeAllegroEvent {
  id: string
  type: string
  occurredAt: string
  /** The checkout form it is about; null for an event without one (the OpenAPI makes it optional). */
  formId: string | null
  /** The event's own snapshot of the Buyer and the lines, as Allegro sends it. */
  order: Record<string, unknown>
}

export interface FakeAllegroCall {
  method: string
  /** The host the request went to (`api.…` or `allegro.…`). */
  host: string
  path: string
  /** Every query parameter, repeated ones in order. */
  query: Record<string, string[]>
  /** JSON or form body, parsed; null without one. */
  body: unknown
}

export interface FakeAllegroState {
  offers: Map<string, FakeAllegroOffer>
  forms: Map<string, CheckoutFormPayload>
  /** The order event journal, oldest first. */
  events: FakeAllegroEvent[]
}

export interface FakeAllegroApiOptions {
  clientId?: string
  clientSecret?: string
  /** Which hosts it answers: those of `environmentHosts(environment)`. Default `sandbox`. */
  environment?: AllegroEnvironment
  /** Device sign-ins are approved as soon as they start (recording the conformance kit, which polls once). */
  autoApproveDevices?: boolean
  /** Default: the sample Offers (`samples.ts`). */
  offers?: ListingOfferPayload[]
  /** Default: the sample checkout forms (`samples.ts`). */
  forms?: CheckoutFormPayload[]
  /** Journal entries to start with, oldest first. Default: one per sample form, in the order they last changed. */
  journal?: Array<{ type: string; formId: string | null; occurredAt: string }>
  /** The data clock (see `FAKE_ALLEGRO_NOW`). */
  now?: () => string
}

export interface FakeAllegroApi {
  /** Answers requests to the environment's API and OAuth hosts; anything else fails like an unreachable host. */
  fetch: typeof fetch
  state: FakeAllegroState
  /** Every request answered, in order. */
  calls: FakeAllegroCall[]
  /** Every access and refresh token handed out, to prove none reached a cassette. */
  issuedTokens: string[]
  /** Credentials as if the seller had signed in. */
  signIn(): AllegroCredentials
  /** Approves a pending device sign-in, as the seller on Allegro's page would. */
  approve(userCode: string): void
  /** The seller unlinked the application: every access and refresh token issued so far stops working. */
  revokeTokens(): void
  /** Appends a journal entry about the form (its current snapshot); returns the event id. */
  addEvent(type: string, formId: string | null, occurredAt?: string): string
  /** Adds the form, or replaces the one with its id. */
  setForm(form: CheckoutFormPayload): void
  /** The form is gone (merged into another): `GET` answers 404. */
  removeForm(id: string): void
  /** Every later `PATCH` of the Offer (stock, publication or price) answers 422 with this error code. */
  rejectOffer(offerId: string, code: string): void
  /**
   * The next `times` `PATCH`es of the Offer answer 409 (an earlier edit still being processed). Documented, never seen
   * on the sandbox: there only to exercise the connector's guard.
   */
  conflictOffer(offerId: string, times?: number): void
  /** The next reopen (`publication.status: ACTIVE`) of the Offer answers 409; never seen on the sandbox either. */
  conflictReopen(offerId: string): void
  /** The next `PATCH` of the Offer answers 202 with the Offer as it was before the edit, as a reopen always does. */
  acceptLater(offerId: string): void
  /** Every later `PATCH` of the Offer answers 403 (another seller's Offer, or a missing scope). */
  forbidOffer(offerId: string): void
}

/** Allegro event ids are decimal integers that grow with time (`1791663869066571`, like a time in microseconds). */
export function fakeEventId(sequence: number): string {
  return String(1_791_663_800_000_000 + sequence * 1_000)
}

function randomText(bytes: number): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...values)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64Url(value: object): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function apiJson(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': PUBLIC_JSON, ...headers } })
}

function oauthJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json;charset=UTF-8' } })
}

// `ErrorsHolder`: the message texts are Allegro's own kind (they never reach Hanza).
function errors(status: number, code: string, message: string, path: string | null = null): Response {
  return apiJson(status, { errors: [{ code, message, details: null, path, userMessage: message, metadata: {} }] })
}

// As the sandbox answers a bad or missing bearer token.
function unauthorized(error: string, description: string): Response {
  const response = oauthJson(401, { error, error_description: description })
  if (error === 'invalid_token') {
    response.headers.set('www-authenticate', `Bearer realm="oauth2-resource", error="invalid_token", error_description="${description}"`)
  }
  return response
}

function latestBoughtAt(form: CheckoutFormPayload): string {
  const times = form.lineItems.map((item) => item.boughtAt).filter((time): time is string => typeof time === 'string')
  return times.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? (form.updatedAt as string)
}

function seedJournal(forms: CheckoutFormPayload[]): Array<{ type: string; formId: string; occurredAt: string }> {
  const typeOf = (form: CheckoutFormPayload): string => {
    if (form.status === 'CANCELLED') return form.payment?.finishedAt ? 'BUYER_CANCELLED' : 'AUTO_CANCELLED'
    if (form.fulfillment?.status && form.fulfillment.status !== 'NEW') return 'FULFILLMENT_STATUS_CHANGED'
    return form.status as string
  }
  return forms
    .map((form) => ({ type: typeOf(form), formId: form.id, occurredAt: (form.updatedAt ?? latestBoughtAt(form)) as string }))
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
}

/** The sample forms as Allegro would send them, with a PESEL the lint recognises. */
function seedForm(form: CheckoutFormPayload): CheckoutFormPayload {
  const copy = clone(form) as CheckoutFormPayload & { buyer: Record<string, unknown> }
  if ('personalIdentity' in copy.buyer) copy.buyer.personalIdentity = PESEL_LIKE
  return copy
}

function seedOffer(offer: ListingOfferPayload): FakeAllegroOffer {
  const lookup = Object.values(productOffers).find((product) => product.id === offer.id)
  const endedBy = lookup?.publication?.endedBy ?? (offer.publication?.status === 'ENDED' ? 'USER' : null)
  return { listing: clone(offer), endedBy }
}

/**
 * A single-valued query parameter (`type: string` in the OpenAPI): like a real server, only the last value counts
 * when it is repeated, so nothing the connector does may rely on repeating it.
 */
function single(url: URL, name: string): string | null {
  return url.searchParams.getAll(name).at(-1) ?? null
}

function queryOf(url: URL): Record<string, string[]> {
  const query: Record<string, string[]> = {}
  for (const [name, value] of url.searchParams) (query[name] ??= []).push(value)
  return query
}

/** `createFakeAllegroApi()` with the sample data: what the conformance recording and the scenarios run against. */
export function createFakeAllegroApi(options: FakeAllegroApiOptions = {}): FakeAllegroApi {
  const clientId = options.clientId ?? 'fake-allegro-client-id'
  const clientSecret = options.clientSecret ?? 'fake-allegro-client-secret'
  const hosts = environmentHosts(options.environment ?? 'sandbox')
  const apiOrigin = new URL(hosts.api).origin
  const oauthUrl = new URL(hosts.oauth)
  const now = options.now ?? (() => FAKE_ALLEGRO_NOW)

  const forms = (options.forms ?? Object.values(sampleForms)).map(seedForm)
  const state: FakeAllegroState = {
    offers: new Map((options.offers ?? Object.values(sampleOffers)).map((offer) => [offer.id, seedOffer(offer)])),
    forms: new Map(forms.map((form) => [form.id, form])),
    events: [],
  }
  const calls: FakeAllegroCall[] = []
  const issuedTokens: string[] = []
  const accessTokens = new Set<string>()
  const refreshTokens = new Set<string>()
  // Rotated refresh tokens and when they were spent (data clock): still taken within the grace period.
  const spentRefreshTokens = new Map<string, number>()
  const devices = new Map<string, { userCode: string; approved: boolean; used: boolean }>()
  const rejections = new Map<string, string>()
  const conflicts = new Map<string, number>()
  const reopenConflicts = new Set<string>()
  const later = new Set<string>()
  const forbidden = new Set<string>()
  let eventSequence = 0
  let revision = 0
  // Counters, not random values, for what is not a secret: recording the same scenario again gives the same file.
  let issued = 0
  let operations = 0

  const addEvent = (type: string, formId: string | null, occurredAt = now()): string => {
    const id = fakeEventId(++eventSequence)
    const form = formId === null ? undefined : state.forms.get(formId)
    const order: Record<string, unknown> = {
      seller: { id: SELLER.id },
      marketplace: { id: 'allegro-pl' },
      ...(form
        ? {
            buyer: { id: form.buyer.id, email: form.buyer.email, login: form.buyer.login, guest: form.buyer.guest ?? false },
            lineItems: form.lineItems.map((item) => ({ ...clone(item) })),
          }
        : {}),
      ...(formId === null ? {} : { checkoutForm: { id: formId, revision: form?.revision ?? null } }),
    }
    state.events.push({ id, type, occurredAt, formId, order })
    return id
  }
  for (const entry of options.journal ?? seedJournal(forms)) addEvent(entry.type, entry.formId, entry.occurredAt)

  const issueTokens = () => {
    // Allegro's access tokens are JWTs; the refresh token is opaque here.
    const accessToken = `${base64Url({ alg: 'RS256', typ: 'JWT' })}.${base64Url({ user_name: SELLER.id, jti: randomText(8) })}.${randomText(32)}`
    const refreshToken = randomText(48)
    accessTokens.add(accessToken)
    refreshTokens.add(refreshToken)
    issuedTokens.push(accessToken, refreshToken)
    return { accessToken, refreshToken, serial: ++issued }
  }
  const tokenBody = (pair: ReturnType<typeof issueTokens>) => ({
    access_token: pair.accessToken,
    token_type: 'bearer',
    refresh_token: pair.refreshToken,
    expires_in: ACCESS_TOKEN_SECONDS,
    scope: 'allegro:api:orders:read allegro:api:orders:write allegro:api:sale:offers:read allegro:api:sale:offers:write allegro:api:profile:read',
    allegro_api: true,
    jti: `00000000-0000-4000-8000-${String(pair.serial).padStart(12, '0')}`,
  })

  const productOfferBody = (offer: FakeAllegroOffer) => ({
    id: offer.listing.id,
    name: offer.listing.name,
    language: 'pl-PL',
    category: { id: '257929' },
    external: offer.listing.external ?? null,
    sellingMode: offer.listing.sellingMode ? { ...offer.listing.sellingMode, ...(offer.price ? { price: offer.price } : {}) } : null,
    stock: { available: offer.listing.stock?.available ?? 0, unit: 'UNIT' },
    publication: { status: offer.listing.publication?.status ?? 'INACTIVE', endedBy: offer.endedBy, republish: false },
  })

  // --- OAuth ---------------------------------------------------------------------------------------------------

  const basicClient = (request: Request) => {
    const encoded = /^Basic (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1]
    try {
      return encoded !== undefined && atob(encoded) === `${clientId}:${clientSecret}`
    } catch {
      return false
    }
  }

  const oauth = (request: Request, url: URL, form: URLSearchParams): Response => {
    if (request.method !== 'POST') return oauthJson(405, { error: 'method_not_allowed' })
    if (!basicClient(request)) return oauthJson(401, { error_description: 'Client authentication failed', error: 'invalid_client' })
    const endpoint = url.pathname.slice(oauthUrl.pathname.length)

    if (endpoint === '/device') {
      if (url.searchParams.get('client_id') !== clientId) return oauthJson(400, { error: 'invalid_client' })
      const deviceCode = randomText(24)
      // Eight lower-case letters, as the sandbox gives them (`cfnbwjrn`).
      const userCode = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => String.fromCharCode(97 + (byte % 26))).join('')
      devices.set(deviceCode, { userCode, approved: options.autoApproveDevices === true, used: false })
      return oauthJson(200, {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: `${hosts.site}/uzytkownik/bezpieczenstwo/skojarz-aplikacje`,
        verification_uri_complete: `${hosts.site}/uzytkownik/bezpieczenstwo/skojarz-aplikacje?code=${userCode}`,
        expires_in: DEVICE_CODE_SECONDS,
        interval: 5,
      })
    }

    if (endpoint === '/token' && form.get('grant_type') === DEVICE_CODE_GRANT) {
      const device = devices.get(form.get('device_code') ?? '')
      // The sandbox's answer to an unknown device code (a used one assumed the same).
      if (!device || device.used) return oauthJson(400, { error_description: 'Invalid device code', error: 'invalid_request' })
      if (!device.approved) return oauthJson(400, { error: 'authorization_pending' })
      device.used = true
      return oauthJson(200, tokenBody(issueTokens()))
    }

    if (endpoint === '/token' && form.get('grant_type') === 'refresh_token') {
      const refreshToken = form.get('refresh_token') ?? ''
      const spentAt = spentRefreshTokens.get(refreshToken)
      const inGrace = spentAt !== undefined && Date.parse(now()) - spentAt <= REFRESH_GRACE_MS
      if (!refreshTokens.has(refreshToken) && !inGrace) {
        return oauthJson(400, { error_description: 'Invalid refresh token', error: 'invalid_grant' })
      }
      // Rotation: both tokens are new. The spent refresh token is still taken for a while, and the old access token
      // stays valid until it expires (both seen on the sandbox).
      if (refreshTokens.delete(refreshToken)) spentRefreshTokens.set(refreshToken, Date.parse(now()))
      return oauthJson(200, tokenBody(issueTokens()))
    }

    return oauthJson(400, { error: 'unsupported_grant_type' })
  }

  // --- REST API ---------------------------------------------------------------------------------------------------

  const listOffers = (url: URL): Response => {
    const limit = Number(single(url, 'limit') ?? '20')
    const offset = Number(single(url, 'offset') ?? '0')
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0) {
      return errors(422, 'VALIDATION_ERROR', 'Limit or offset is out of range')
    }
    const statuses = url.searchParams.getAll('publication.status')
    const matching = [...state.offers.values()]
      .filter((offer) => statuses.length === 0 || statuses.includes(offer.listing.publication?.status ?? 'INACTIVE'))
      // Allegro's default order: newest (highest id) first.
      .sort((a, b) => (a.listing.id < b.listing.id ? 1 : a.listing.id > b.listing.id ? -1 : 0))
    const page = matching.slice(offset, offset + limit).map((offer) => clone(offer.listing))
    return apiJson(200, { offers: page, count: page.length, totalCount: matching.length })
  }

  const editOffer = async (request: Request, offerId: string): Promise<Response> => {
    const offer = state.offers.get(offerId)
    if (!offer) return errors(404, 'NOT_FOUND', 'Offer not found')
    if (forbidden.has(offerId)) return errors(403, 'ACCESS_DENIED', 'Access denied')
    const pendingConflicts = conflicts.get(offerId) ?? 0
    if (pendingConflicts > 0) {
      conflicts.set(offerId, pendingConflicts - 1)
      return errors(409, 'OPERATION_IN_PROGRESS', 'The previous edition of the offer is still being processed')
    }
    const code = rejections.get(offerId)
    if (code !== undefined) return errors(422, code, 'The offer cannot be edited')
    const body = (await request.json().catch(() => null)) as {
      stock?: { available?: unknown }
      publication?: { status?: unknown }
      sellingMode?: { price?: { amount?: unknown; currency?: unknown } }
    } | null
    if (body === null || typeof body !== 'object') return errors(400, 'INVALID_BODY', 'The request body is not valid JSON')

    const listing = offer.listing
    const status = () => listing.publication?.status ?? 'INACTIVE'
    const setStatus = (next: string) => {
      listing.publication = { ...(listing.publication ?? {}), status: next }
    }
    const before = productOfferBody(offer)
    if (body.sellingMode !== undefined) {
      const price = body.sellingMode?.price
      const amount = price?.amount
      if (typeof amount !== 'string' || !PRICE_AMOUNT.test(amount)) {
        return errors(422, 'VALIDATION_ERROR', 'Enter a valid price', 'sellingMode.price.amount')
      }
      // The sandbox's answer to EUR on an allegro.pl Offer: a currency the Offer's marketplace does not use.
      const currency = listing.sellingMode?.price?.currency ?? 'PLN'
      if (price?.currency !== currency) {
        return errors(422, 'IncorrectBaseCurrency', 'Currency is incorrect for the specified market.', 'prices[0].price.currency')
      }
      if (Number(amount) < MIN_PRICE) {
        return errors(422, 'PriceBelowMin', `Price must be equal to or higher than 1.00 ${currency}.`, 'prices[0].price.amount')
      }
      const [units, fraction = ''] = amount.split('.')
      offer.price = { amount: `${units}.${fraction.padEnd(2, '0')}`, currency }
      // Java's `Double.toString`, as the listing writes prices: `19.90` → `19.9`, `25` → `25.0`.
      const listed = String(Number(amount))
      listing.sellingMode = { ...(listing.sellingMode ?? {}), price: { amount: listed.includes('.') ? listed : `${listed}.0`, currency } }
    }
    let ending = false
    let reopening = false
    if (body.stock !== undefined) {
      const available = body.stock?.available
      if (typeof available !== 'number' || !Number.isInteger(available) || available < 0) {
        return errors(422, 'VALIDATION_ERROR', 'stock.available must be a non-negative integer')
      }
      listing.stock = { ...(listing.stock ?? {}), available }
      // "Setting this quantity to 0 for 'ACTIVE' or 'ACTIVATING' offer will trigger changing its status to 'ENDED'".
      // A number above 0 leaves an ended Offer ended (seen on the sandbox).
      ending = available === 0 && (status() === 'ACTIVE' || status() === 'ACTIVATING')
    }
    if (body.publication !== undefined) {
      if (body.publication?.status !== 'ACTIVE') return errors(422, 'VALIDATION_ERROR', 'Unsupported publication status')
      // An Offer is activated only with stock above 0.
      if ((listing.stock?.available ?? 0) <= 0) return errors(422, 'OFFER_STOCK_EMPTY', 'The offer has no stock to be activated')
      if (reopenConflicts.delete(offerId)) {
        return errors(409, 'OPERATION_IN_PROGRESS', 'The previous edition of the offer is still being processed')
      }
      reopening = status() !== 'ACTIVE'
    }
    // Allegro changes the publication after it answers (seconds later on the sandbox): a 200 shows the new stock with
    // the publication as it was, a 202 the whole Offer as it was. The next read shows the change done.
    const answered = productOfferBody(offer)
    if (ending) {
      setStatus('ENDED')
      offer.endedBy = 'EMPTY_STOCK'
    }
    if (reopening) {
      setStatus('ACTIVE')
      offer.endedBy = null
    }
    if (later.delete(offerId) || reopening) {
      return apiJson(202, before, {
        location: `${hosts.api}/sale/product-offers/${encodeURIComponent(offerId)}/operations/00000000-0000-4000-8000-${String(++operations).padStart(12, '0')}`,
        'retry-after': '120',
      })
    }
    return apiJson(200, answered)
  }

  const listForms = (url: URL): Response => {
    const limit = Number(single(url, 'limit') ?? '100')
    const offset = Number(single(url, 'offset') ?? '0')
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset + limit > 10_000) {
      return errors(422, 'VALIDATION_ERROR', 'Limit or offset is out of range')
    }
    const sort = single(url, 'sort') ?? '-lineItems.boughtAt'
    if (sort !== 'lineItems.boughtAt' && sort !== '-lineItems.boughtAt') return errors(400, 'VALIDATION_ERROR', 'Unsupported sort')
    const status = single(url, 'status')
    const fulfillment = single(url, 'fulfillment.status')
    const lte = single(url, 'lineItems.boughtAt.lte')
    const gte = single(url, 'lineItems.boughtAt.gte')
    for (const bound of [lte, gte]) if (bound !== null && Number.isNaN(Date.parse(bound))) return errors(400, 'VALIDATION_ERROR', 'Invalid date')
    const direction = sort.startsWith('-') ? -1 : 1
    const matching = [...state.forms.values()]
      .filter((form) => status === null || form.status === status)
      .filter((form) => fulfillment === null || (form.fulfillment?.status ?? 'NEW') === fulfillment)
      .filter((form) => lte === null || Date.parse(latestBoughtAt(form)) <= Date.parse(lte))
      .filter((form) => gte === null || Date.parse(latestBoughtAt(form)) >= Date.parse(gte))
      // By the latest purchase time; the id breaks ties, so the order never changes between pages.
      .sort((a, b) => direction * (Date.parse(latestBoughtAt(a)) - Date.parse(latestBoughtAt(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))
    const page = matching.slice(offset, offset + limit).map(clone)
    return apiJson(200, { checkoutForms: page, count: page.length, totalCount: matching.length })
  }

  const listEvents = (url: URL): Response => {
    const limit = Number(single(url, 'limit') ?? '100')
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return errors(422, 'VALIDATION_ERROR', 'Limit is out of range')
    const from = single(url, 'from')
    let start = 0
    if (from !== null) {
      // As on the sandbox: `from` must be an integer in [0, 2^63 - 1] (422 otherwise), it is exclusive, and an integer
      // the journal has no event for (far before the first, or after the last) answers an empty page, never an error.
      if (!/^\d{1,19}$/.test(from) || BigInt(from) > MAX_EVENT_ID) {
        return errors(422, 'VALIDATION_ERROR', 'must be greater than or equal to 0', 'getOrderEvents.from')
      }
      const index = state.events.findIndex((event) => event.id === from)
      if (index === -1) return apiJson(200, { events: [] })
      start = index + 1
    }
    const types = url.searchParams.getAll('type')
    const events = state.events
      .slice(start)
      .filter((event) => types.length === 0 || types.includes(event.type))
      .slice(0, limit)
      .map((event) => ({ id: event.id, occurredAt: event.occurredAt, type: event.type, order: clone(event.order) }))
    return apiJson(200, { events })
  }

  const setFulfillment = async (request: Request, formId: string): Promise<Response> => {
    const body = (await request.json().catch(() => null)) as { status?: unknown } | null
    const status = body?.status
    if (typeof status !== 'string' || !SELLER_FULFILLMENT_STATUSES.includes(status)) {
      return errors(422, 'VALIDATION_ERROR', 'The status is not allowed')
    }
    // An unknown form is a 422 here, not a 404 (seen on the sandbox). Any seller status is accepted after any other.
    const form = state.forms.get(formId)
    if (!form) return errors(422, 'SellerOrdersStoreUnprocessableEntityException', `Failed to set status ${status} on order ${formId}`)
    form.fulfillment = { ...(form.fulfillment ?? {}), status }
    form.updatedAt = now()
    form.revision = `fa${String(++revision).padStart(6, '0')}`
    addEvent('FULFILLMENT_STATUS_CHANGED', formId)
    return new Response(null, { status: 204 })
  }

  const api = async (request: Request, url: URL): Promise<Response> => {
    if (request.headers.get('accept') !== PUBLIC_JSON) return errors(406, 'NOT_ACCEPTABLE', 'Use the public media type')
    const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1]
    if (!token) return unauthorized('unauthorized', 'Full authentication is required to access this resource')
    if (!accessTokens.has(token)) {
      // The sandbox's text for a token that is not a JWT; an issued but revoked one is assumed to answer alike.
      return unauthorized('invalid_token', token.split('.').length === 3 ? 'Invalid access token' : 'Cannot convert access token to JSON')
    }
    if (!['GET', 'HEAD'].includes(request.method) && request.headers.get('content-type') !== PUBLIC_JSON) {
      return errors(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use the public media type')
    }
    const { pathname: path } = url
    const segment = (pattern: RegExp) => {
      const match = pattern.exec(path)
      return match ? decodeURIComponent(match[1]!) : null
    }

    if (request.method === 'GET' && path === '/me') {
      return apiJson(200, {
        id: SELLER.id,
        login: SELLER.login,
        firstName: 'Tomasz',
        lastName: 'Sprzedawca',
        email: 'tomasz.sprzedawca@allegro-sandbox-seller.pl',
        baseMarketplace: { id: 'allegro-pl' },
      })
    }
    if (request.method === 'GET' && path === '/sale/offers') return listOffers(url)
    const productOfferId = segment(/^\/sale\/product-offers\/([^/]+)$/)
    if (productOfferId !== null && request.method === 'GET') {
      const offer = state.offers.get(productOfferId)
      return offer ? apiJson(200, productOfferBody(offer)) : errors(404, 'NOT_FOUND', 'Offer not found')
    }
    if (productOfferId !== null && request.method === 'PATCH') return editOffer(request, productOfferId)
    if (request.method === 'GET' && path === '/order/event-stats') {
      const latest = state.events.at(-1)
      return apiJson(200, { latestEvent: latest ? { id: latest.id, occurredAt: latest.occurredAt } : null })
    }
    if (request.method === 'GET' && path === '/order/events') return listEvents(url)
    if (request.method === 'GET' && path === '/order/checkout-forms') return listForms(url)
    const fulfillmentFormId = segment(/^\/order\/checkout-forms\/([^/]+)\/fulfillment$/)
    if (fulfillmentFormId !== null && request.method === 'PUT') return setFulfillment(request, fulfillmentFormId)
    const formId = segment(/^\/order\/checkout-forms\/([^/]+)$/)
    if (formId !== null && request.method === 'GET') {
      if (!TIME_UUID.test(formId)) return errors(422, 'VALIDATION_ERROR', 'Not valid time UUID', 'getOrder.checkoutFormId')
      const form = state.forms.get(formId)
      // A merged form is assumed to answer 404 (not produced on the sandbox).
      return form ? apiJson(200, clone(form)) : errors(404, 'NOT_FOUND', 'Order not found')
    }
    return errors(404, 'NOT_FOUND', 'Resource not found')
  }

  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const isApi = url.origin === apiOrigin
    const isOAuth = url.origin === oauthUrl.origin && url.pathname.startsWith(`${oauthUrl.pathname}/`)
    if (!isApi && !isOAuth) throw new TypeError(`The Allegro simulation answers only ${apiOrigin} and ${hosts.oauth}`)
    const text = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.clone().text()
    const contentType = request.headers.get('content-type') ?? ''
    const form = new URLSearchParams(contentType.includes('x-www-form-urlencoded') ? text : '')
    let body: unknown = null
    if (text !== '' && contentType.includes('json')) body = JSON.parse(text)
    else if (text !== '') body = Object.fromEntries(form)
    calls.push({ method: request.method, host: url.host, path: url.pathname, query: queryOf(url), body })
    const response = isApi ? await api(request, url) : oauth(request, url, form)
    // Every answer carries the server's time, as HTTP requires; the Order feed takes its boundary from it.
    response.headers.set('date', new Date(now()).toUTCString())
    return response
  }

  return {
    fetch: fakeFetch,
    state,
    calls,
    issuedTokens,
    signIn() {
      const { accessToken, refreshToken } = issueTokens()
      return { accessToken, refreshToken, accessTokenExpiresAt: new Date(Date.now() + ACCESS_TOKEN_SECONDS * 1000).toISOString() }
    },
    approve(userCode) {
      const device = [...devices.values()].find((candidate) => candidate.userCode === userCode)
      if (!device) throw new Error(`No device sign-in with user code ${userCode}`)
      device.approved = true
    },
    revokeTokens() {
      accessTokens.clear()
      refreshTokens.clear()
      spentRefreshTokens.clear()
    },
    addEvent,
    setForm(form) {
      state.forms.set(form.id, clone(form))
    },
    removeForm(id) {
      state.forms.delete(id)
    },
    rejectOffer(offerId, code) {
      rejections.set(offerId, code)
    },
    conflictOffer(offerId, times = 1) {
      conflicts.set(offerId, (conflicts.get(offerId) ?? 0) + times)
    },
    conflictReopen(offerId) {
      reopenConflicts.add(offerId)
    },
    acceptLater(offerId) {
      later.add(offerId)
    },
    forbidOffer(offerId) {
      forbidden.add(offerId)
    },
  }
}
