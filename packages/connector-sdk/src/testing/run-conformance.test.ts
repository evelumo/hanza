import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { defineConnector, type CapabilityContext } from '../connector'
import { CursorExpiredError, errorFromResponse, TransientError, type ErrorFromResponseOptions } from '../errors'
import type { Offer } from '../model/offer'
import type { Order } from '../model/order'
import { loadCassette, writeCassette } from './cassette'
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
