import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { defineConnector, type CapabilityContext } from '../connector'
import { CursorExpiredError, errorFromResponse, TransientError, type ErrorFromResponseOptions } from '../errors'
import type { Offer } from '../model/offer'
import type { Order } from '../model/order'
import { shipmentStateSchema, type ShipmentRequest, type ShipmentState } from '../model/shipment'
import { bodyToBytes, loadCassette, writeCassette } from './cassette'
import { CONFORMANCE_CASSETTE, isRecording, openCassette, runConformance, UNAUTHORIZED_CASSETTE, withFetch } from './run-conformance'

const API = 'https://stub.example.test'
const LIVE_KEY = 'live-api-key-0123456789'

const offers: Offer[] = [
  { externalId: 'o1', sku: 'SKU-1', name: 'Mug', url: null, price: { amount: '39.99', currency: 'PLN' } },
  { externalId: 'o2', sku: null, name: 'Poster', url: null, price: null },
  { externalId: 'o3', sku: 'SKU-3', name: 'Tote bag', url: null, price: null },
]

const order = (externalId: string): Order => ({
  externalId,
  placedAt: '2026-10-01T09:00:00Z',
  payment: 'prepaid',
  total: { amount: '10.00', currency: 'PLN' },
  buyer: { name: 'Jan', email: 'jan.kowalski@poczta.pl', phone: null, login: null },
  shippingAddress: { name: 'Jan', company: null, street: '1 Test Street', postalCode: '00-001', city: 'Warsaw', countryCode: 'PL', phone: null, taxId: null },
  billingAddress: null,
  lines: [{ externalId: 'l1', offerExternalId: 'o1', sku: 'SKU-1', name: 'Mug', quantity: 1, unitPrice: { amount: '10.00', currency: 'PLN' } }],
  facts: [],
})
const orders = [order('a'), order('b'), order('c')]

function page<T>(items: T[], cursor: string | null) {
  const start = cursor === null ? 0 : Number(cursor)
  const end = Math.min(start + 2, items.length)
  return { items: items.slice(start, end), nextCursor: String(end), hasMore: end < items.length }
}

/** The "real API" for these tests: an in-process handler, no sockets. */
const channel: typeof fetch = async (input, init) => {
  const request = new Request(input, init)
  if (request.headers.get('authorization') !== `Bearer ${LIVE_KEY}`) return Response.json({ error: 'unauthorized' }, { status: 401 })
  const url = new URL(request.url)
  const cursor = url.searchParams.get('cursor')
  if (url.pathname === '/offers') return Response.json(page(offers, cursor))
  // A journal position the API no longer keeps.
  if (url.pathname === '/orders' && cursor === 'gone') return Response.json({ error: 'cursor expired' }, { status: 410 })
  if (url.pathname === '/orders') return Response.json(page(orders, cursor))
  if (url.pathname === '/stock' && request.method === 'PUT') return new Response(null, { status: 204 })
  return Response.json({ error: 'not found' }, { status: 404 })
}

const pageSchema = z.object({ items: z.array(z.any()), nextCursor: z.string().nullable(), hasMore: z.boolean() })
type Ctx = CapabilityContext<Record<string, never>, { apiKey: string }, Record<string, never>>

async function call(ctx: Ctx, path: string, init: RequestInit = {}, errors: ErrorFromResponseOptions = {}) {
  let response: Response
  try {
    response = await ctx.fetch(`${API}${path}`, { ...init, headers: { accept: 'application/json', authorization: `Bearer ${ctx.credentials.apiKey}` } })
  } catch (error) {
    // Like a real connector: a failed fetch is transient, and the cause's message is not repeated.
    throw new TransientError('network failure', { cause: error })
  }
  if (!response.ok) throw await errorFromResponse(response, errors)
  return response
}

const stubConnector = (errors: ErrorFromResponseOptions = {}) => defineConnector({
  id: 'stub',
  name: 'Stub',
  kind: 'marketplace',
  auth: { type: 'apiKey' },
  configSchema: z.object({}),
  credentialsSchema: z.object({ apiKey: z.string().min(1).describe('API key') }),
  capabilities: {
    async 'offers.pull'(ctx, cursor) {
      return pageSchema.parse(await (await call(ctx, `/offers${cursor === null ? '' : `?cursor=${cursor}`}`, {}, errors)).json())
    },
    async 'orders.pull'(ctx, cursor) {
      return pageSchema.parse(await (await call(ctx, `/orders${cursor === null ? '' : `?cursor=${cursor}`}`, {}, errors)).json())
    },
    async 'stock.push'(ctx, levels) {
      if (levels.length > 0) await call(ctx, '/stock', { method: 'PUT', body: JSON.stringify(levels) }, errors)
    },
  },
})
const connector = stubConnector()

const replayOptions = (fixtures: string) => ({
  fixtures,
  config: {},
  credentials: { apiKey: 'replay-api-key' },
  unauthorized: { credentials: { apiKey: 'revoked-api-key' } },
  recording: () => ({ credentials: { apiKey: LIVE_KEY }, fetch: channel }),
})

describe('runConformance', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hanza-conformance-'))
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(dir, { recursive: true, force: true })
  })

  async function record() {
    vi.stubEnv('CI', '')
    vi.stubEnv('HANZA_RECORD_FIXTURES', '1')
    await runConformance(connector, replayOptions(dir))
    vi.unstubAllEnvs()
    vi.stubEnv('HANZA_RECORD_FIXTURES', '')
  }

  it('records both cassettes from the real API, scrubbed, then replays them offline with other credentials', async () => {
    await record()
    const main = await readFile(join(dir, CONFORMANCE_CASSETTE), 'utf8')
    expect(main).not.toContain(LIVE_KEY)
    expect(main).not.toContain('jan.kowalski@poczta.pl')
    expect(main).toContain('person-1@example.com')
    const unauthorized = await loadCassette(join(dir, UNAUTHORIZED_CASSETTE))
    expect(unauthorized.interactions.map((interaction) => interaction.response.status)).toEqual([401])

    await runConformance(connector, { ...replayOptions(dir), recording: () => ({ fetch: () => Promise.reject(new Error('no network in replay')) }) })
  })

  it('records and replays the expired-cursor check (C18) in the main cassette', async () => {
    const expiring = defineConnector({
      ...connector,
      capabilities: {
        ...connector.capabilities,
        async 'orders.pull'(ctx, cursor) {
          try {
            return await connector.capabilities['orders.pull']!(ctx, cursor)
          } catch (error) {
            if ((error as Error).message.startsWith('410')) throw new CursorExpiredError('cursor expired', { cause: error })
            throw error
          }
        },
      },
    })
    vi.stubEnv('CI', '')
    vi.stubEnv('HANZA_RECORD_FIXTURES', '1')
    await runConformance(expiring, { ...replayOptions(dir), expiredCursor: 'gone' })
    vi.unstubAllEnvs()
    vi.stubEnv('HANZA_RECORD_FIXTURES', '')
    const main = await loadCassette(join(dir, CONFORMANCE_CASSETTE))
    expect(main.interactions.filter((interaction) => interaction.response.status === 410)).toHaveLength(1)

    await runConformance(expiring, { ...replayOptions(dir), expiredCursor: 'gone' })
    // The plain connector reports the 410 as permanent, which C18 refuses.
    await expect(runConformance(connector, { ...replayOptions(dir), expiredCursor: 'gone' })).rejects.toThrow('[C18]')
  })

  it('refuses to record in CI', async () => {
    vi.stubEnv('CI', 'true')
    vi.stubEnv('HANZA_RECORD_FIXTURES', '1')
    await expect(runConformance(connector, replayOptions(dir))).rejects.toThrow('HANZA_RECORD_FIXTURES is set in CI')
  })

  it('reports requests the cassette cannot answer, even when the connector hid the error', async () => {
    await record()
    const file = join(dir, CONFORMANCE_CASSETTE)
    const cassette = await loadCassette(file)
    await writeCassette(file, { ...cassette, interactions: cassette.interactions.filter((interaction) => !interaction.request.url.endsWith('/orders?cursor=2')) })

    const error = await runConformance(connector, replayOptions(dir)).catch((caught: Error) => caught)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('[C6] unexpected failure: TransientError: network failure')
    expect((error as Error).message).toContain(`Unmatched requests:\nNo recorded interaction in ${CONFORMANCE_CASSETTE} for GET ${API}/orders?cursor=2.`)
  })

  it('fails on a fixture set that leaks a secret, before replaying anything', async () => {
    await record()
    await writeFile(join(dir, 'raw-order.json'), JSON.stringify({ note: 'Bearer abcdefgh12345678' }))
    await expect(runConformance(connector, replayOptions(dir))).rejects.toThrow(/raw-order\.json: note \[bearer\] Bear… \(23 chars\)/)
  })

  it('runs C14 on the replay, and skips it with forbidden: false for a Channel that signs out with 403', async () => {
    await record()
    const signsOutWith403 = stubConnector({ isAuthFailure: (response) => response.status === 403 })
    await expect(runConformance(signsOutWith403, replayOptions(dir))).rejects.toThrow(/\[C14\] orders\.pull failed as 'auth_expired' on a 403/)
    await expect(runConformance(signsOutWith403, { ...replayOptions(dir), forbidden: false })).resolves.toBeUndefined()
  })

  it('explains how to record a missing cassette', async () => {
    await expect(runConformance(connector, replayOptions(dir))).rejects.toThrow(/No cassette at .*conformance\.cassette\.json\. Record it with HANZA_RECORD_FIXTURES=1/)
  })
})

const LIVE_LABEL = '%PDF-1.7 Jan Kowalski, ul. Testowa 1, 00-001 Warszawa'

const shipmentRequest: ShipmentRequest = {
  reference: 'shp_conformance_1',
  requestedAt: '2026-10-10T09:00:00Z',
  service: 'locker',
  receiver: { name: 'Jan Testowy', company: null, email: 'jan.kowalski@poczta.pl', phone: '600100200' },
  destination: { type: 'pickup_point', pointId: 'KRA010' },
  parcel: { preset: 'small' },
  cashOnDelivery: null,
}
const refusedRequest: ShipmentRequest = { ...shipmentRequest, reference: 'shp_conformance_2', destination: { type: 'pickup_point', pointId: 'NOWHERE' } }

/**
 * The "real Carrier": no idempotency key, so a repeated create must be found by its reference; it confirms a
 * Shipment once it was read twice, and has a Label (a PDF with the receiver on it) only from then on.
 */
function carrier(): typeof fetch {
  const shipments: Array<ShipmentState & { reference: string }> = []
  const reads = new Map<string, number>()
  return async (input, init) => {
    const request = new Request(input, init)
    if (request.headers.get('authorization') !== `Bearer ${LIVE_KEY}`) return Response.json({ error: 'token_invalid' }, { status: 401 })
    const url = new URL(request.url)
    const label = /^\/shipments\/([^/]+)\/label$/.exec(url.pathname)
    if (label) {
      const shipment = shipments.find((candidate) => candidate.externalId === label[1])
      if (!shipment) return Response.json({ error: 'resource_not_found' }, { status: 404 })
      if (shipment.status === 'pending') return Response.json({ error: 'invalid_action' }, { status: 409 })
      return new Response(LIVE_LABEL, { headers: { 'content-type': 'application/pdf' } })
    }
    if (url.pathname !== '/shipments') return Response.json({ error: 'not found' }, { status: 404 })
    if (request.method === 'POST') {
      const body = (await request.json()) as { reference: string; pointId: string }
      if (body.pointId === 'NOWHERE') return Response.json({ error: 'validation_failed', field: 'target_point', key: 'does_not_exist' }, { status: 400 })
      const shipment = { reference: body.reference, externalId: String(1000 + shipments.length), status: 'pending' as const, trackingNumber: null, carrierStatus: 'created' }
      shipments.push(shipment)
      return Response.json(shipment, { status: 201 })
    }
    const ids = url.searchParams.get('id')?.split(',')
    const reference = url.searchParams.get('reference')
    const found = shipments.filter((shipment) => (ids ? ids.includes(shipment.externalId) : shipment.reference === reference))
    const items = found.map((shipment) => ({ ...shipment }))
    for (const shipment of ids ? found : []) {
      const count = (reads.get(shipment.externalId) ?? 0) + 1
      reads.set(shipment.externalId, count)
      if (count === 2) Object.assign(shipment, { status: 'ready', trackingNumber: `6${shipment.externalId}`, carrierStatus: 'confirmed' })
    }
    return Response.json({ items })
  }
}

const carrierItems = z.object({ items: z.array(shipmentStateSchema.extend({ reference: z.string() })) })
const toState = ({ reference: _reference, ...state }: ShipmentState & { reference: string }): ShipmentState => state

const stubCourier = defineConnector({
  id: 'stub-courier',
  name: 'Stub courier',
  kind: 'courier',
  auth: { type: 'apiKey' },
  configSchema: z.object({}),
  credentialsSchema: z.object({ apiKey: z.string().min(1).describe('API key') }),
  shipping: {
    services: [{ id: 'locker', name: 'Locker', destination: 'pickup_point', parcel: { type: 'presets', presets: [{ id: 'small', name: 'Small' }] }, cashOnDelivery: false }],
  },
  capabilities: {
    async 'shipments.create'(ctx, request) {
      const earlier = carrierItems.parse(await (await call(ctx, `/shipments?reference=${request.reference}`)).json()).items[0]
      if (earlier) return { outcome: 'created', ...toState(earlier) }
      const pointId = request.destination.type === 'pickup_point' ? request.destination.pointId : null
      const body = JSON.stringify({ reference: request.reference, pointId, receiver: request.receiver })
      const response = await ctx.fetch(`${API}/shipments`, {
        method: 'POST',
        body,
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${ctx.credentials.apiKey}` },
      })
      if (response.status === 400) {
        const refusal = z.object({ field: z.string(), key: z.string() }).parse(await response.json())
        return { outcome: 'rejected', code: `${refusal.field}.${refusal.key}` }
      }
      if (!response.ok) throw await errorFromResponse(response)
      return { outcome: 'created', ...toState(shipmentStateSchema.extend({ reference: z.string() }).parse(await response.json())) }
    },
    async 'shipments.track'(ctx, externalIds) {
      if (externalIds.length === 0) return []
      return carrierItems.parse(await (await call(ctx, `/shipments?id=${externalIds.join(',')}`)).json()).items.map(toState)
    },
    async 'shipments.label'(ctx, { externalId }) {
      const response = await ctx.fetch(`${API}/shipments/${externalId}/label`, { headers: { authorization: `Bearer ${ctx.credentials.apiKey}` } })
      if (response.status === 409) throw new TransientError('no label yet')
      if (!response.ok) throw await errorFromResponse(response)
      return { contentType: response.headers.get('content-type') ?? 'application/octet-stream', data: new Uint8Array(await response.arrayBuffer()) }
    },
  },
})

describe('runConformance for a connector that makes Shipments', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hanza-conformance-'))
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(dir, { recursive: true, force: true })
  })

  // A phone without a leading `+` is found by the lint only under its key, and scrubbed only when declared.
  const options = (binary: { replaceBinaryBodies?: boolean } = {}) => ({
    fixtures: dir,
    config: {},
    credentials: { apiKey: 'replay-api-key' },
    unauthorized: { credentials: { apiKey: 'revoked-api-key' } },
    shipment: { request: shipmentRequest, rejected: { request: refusedRequest } },
    scrub: { keys: { phone: 'phone' as const }, ...binary },
    recording: () => ({ credentials: { apiKey: LIVE_KEY }, fetch: carrier() }),
  })

  async function record(binary?: { replaceBinaryBodies?: boolean }) {
    vi.stubEnv('CI', '')
    vi.stubEnv('HANZA_RECORD_FIXTURES', '1')
    await runConformance(stubCourier, options(binary))
    vi.unstubAllEnvs()
    vi.stubEnv('HANZA_RECORD_FIXTURES', '')
  }

  it('records S1 to S7 with a placeholder for the Label, then replays them offline, the wait for the Label included', async () => {
    await record({ replaceBinaryBodies: true })
    const main = await loadCassette(join(dir, CONFORMANCE_CASSETTE))
    const labels = main.interactions.filter((interaction) => interaction.request.url.endsWith('/label'))
    // No Label while the Shipment is pending, then the file: the replay serves them in that order.
    expect(labels.map((interaction) => interaction.response.status)).toEqual([409, 200])
    expect(labels[1]!.response.headers['content-type']).toBe('application/pdf')
    const file = Buffer.from(bodyToBytes(labels[1]!.response.body)!).toString('latin1')
    expect(file.startsWith('%PDF-1.4')).toBe(true)
    const text = await readFile(join(dir, CONFORMANCE_CASSETTE), 'utf8')
    expect(text).not.toContain(Buffer.from(LIVE_LABEL).toString('base64'))
    expect(text).not.toContain('jan.kowalski@poczta.pl')
    expect(text).not.toContain('600100200')
    expect(text).not.toContain(LIVE_KEY)
    // C11 for a courier: shipments.track of the created Shipment with the refused key.
    const unauthorized = await loadCassette(join(dir, UNAUTHORIZED_CASSETTE))
    expect(unauthorized.interactions.map((interaction) => `${interaction.request.url} ${interaction.response.status}`)).toEqual([`${API}/shipments?id=1000 401`])

    await runConformance(stubCourier, { ...options({ replaceBinaryBodies: true }), recording: () => ({ fetch: () => Promise.reject(new Error('no network in replay')) }) })
  })

  it('fails S5 on the replay of a cassette whose Label was dropped as a binary body', async () => {
    await record()
    await expect(runConformance(stubCourier, options())).rejects.toThrow(/\[S5\] shipments\.label returned an invalid Label/)
  })

  it('requires the shipment fixture', async () => {
    await record({ replaceBinaryBodies: true })
    await expect(runConformance(stubCourier, { ...options({ replaceBinaryBodies: true }), shipment: undefined })).rejects.toThrow(/\[S2\] shipments\.create is implemented: pass a shipment fixture/)
  })
})

describe('openCassette and withFetch', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('records a scenario on demand and replays it into a connector that never sees the switch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hanza-scenario-'))
    const file = join(dir, 'offers.cassette.json')
    try {
      vi.stubEnv('CI', '')
      vi.stubEnv('HANZA_RECORD_FIXTURES', '1')
      let closed = false
      const recording = await openCassette(file, { recording: () => ({ fetch: channel, close: () => void (closed = true) }) })
      expect(recording.mode).toBe('record')
      const live = withFetch(connector, recording.fetch)
      const ctx = (apiKey: string): Ctx => ({ app: {}, config: {}, credentials: { apiKey }, fetch: () => Promise.reject(new Error('ctx.fetch must not be used')), log: () => {} })
      const first = await live.capabilities['offers.pull']!(ctx(LIVE_KEY), null)
      await recording.close()
      expect(closed).toBe(true)

      vi.stubEnv('HANZA_RECORD_FIXTURES', '')
      const replay = await openCassette(file)
      expect(replay.mode).toBe('replay')
      expect(await withFetch(connector, replay.fetch).capabilities['offers.pull']!(ctx('another-key-123'), null)).toEqual(first)
      expect(replay.unused()).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('lints a scenario cassette on replay', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hanza-scenario-'))
    const file = join(dir, 'leaky.cassette.json')
    try {
      await writeCassette(file, {
        version: 1,
        interactions: [
          {
            request: { method: 'GET', url: `${API}/me`, headers: {}, body: null },
            response: { status: 200, headers: { 'content-type': 'application/json' }, body: { json: { sessionToken: 'live-session-token-1' } } },
          },
        ],
      })
      await expect(openCassette(file)).rejects.toThrow(/leaky\.cassette\.json: interactions\.0\.response\.body\.json\.sessionToken \[secret-value\]/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads the switch from the environment', () => {
    expect(isRecording({})).toBe(false)
    expect(isRecording({ HANZA_RECORD_FIXTURES: '1' })).toBe(true)
    expect(isRecording({ HANZA_RECORD_FIXTURES: 'true' })).toBe(false)
    expect(isRecording({ HANZA_RECORD_FIXTURES: '1', CI: 'false' })).toBe(true)
    expect(() => isRecording({ HANZA_RECORD_FIXTURES: '1', CI: '1' })).toThrow(/CI/)
  })
})
