import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isOrderUpdate, type CapabilityContext, type Order, type OrderUpdate } from '@hanza/connector-sdk'
import {
  assertNoSecrets,
  createRecordingFetch,
  createReplayFetch,
  loadCassette,
  runConformance,
  SCRUBBED,
} from '@hanza/connector-sdk/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeHttpConnector, FAKE_HTTP_BASE_URL } from '../index'
import { fakeHttpScrub, startFakeHttpServer, type FakeHttpServer } from './server'

const connector = createFakeHttpConnector()
const replayCredentials = { clientId: 'fake-http-client', clientSecret: 'replay-client-secret' }
const recordedCredentials = { clientId: 'fake-http-client', clientSecret: 'fake-http-client-secret' }

function context(fetch: typeof globalThis.fetch, credentials = replayCredentials) {
  return {
    config: { baseUrl: FAKE_HTTP_BASE_URL },
    credentials,
    fetch,
    log: () => {},
  } satisfies CapabilityContext<{ baseUrl: string }, typeof replayCredentials>
}

describe('fake-http connector with recorded fixtures', () => {
  it('passes the conformance kit against its committed cassettes', async () => {
    await runConformance(connector, {
      fixtures: new URL('./fixtures', import.meta.url),
      config: {},
      credentials: replayCredentials,
      unauthorized: { credentials: { ...replayCredentials, clientSecret: 'wrong-client-secret' } },
      scrub: fakeHttpScrub,
      // Only with HANZA_RECORD_FIXTURES=1: a real connector loads sandbox credentials from its git-ignored .recording/ here.
      recording: async () => {
        const server = await startFakeHttpServer()
        return { credentials: recordedCredentials, fetch: server.fetch, close: server.close }
      },
    })
  })
})

describe('record → scrub → replay through a real HTTP server', () => {
  let server: FakeHttpServer | null = null
  let dir: string | null = null

  afterEach(async () => {
    await server?.close()
    if (dir) await rm(dir, { recursive: true, force: true })
    server = null
    dir = null
  })

  async function exercise(fetch: typeof globalThis.fetch, credentials = replayCredentials) {
    const ctx = context(fetch, credentials)
    const offers = await connector.capabilities['offers.pull']!(ctx, null)
    const orders = await connector.capabilities['orders.pull']!(ctx, null)
    await connector.capabilities['stock.push']!(ctx, [{ offerExternalId: 'fake-offer-1', sku: 'FAKE-SKU-1', available: 7 }])
    await connector.capabilities['orders.updateStatus']!(ctx, { orderExternalId: 'fake-order-1', status: 'shipped' })
    const full = (item: Order | OrderUpdate): Order => {
      if (isOrderUpdate(item)) throw new Error(`unexpected Order update for "${item.externalId}"`)
      return item
    }
    return { offers, orders: { ...orders, items: orders.items.map(full) } }
  }

  it('writes a cassette without credentials or personal data that replays the same answers', async () => {
    server = await startFakeHttpServer()
    dir = await mkdtemp(join(tmpdir(), 'hanza-cassette-'))
    const file = join(dir, 'round-trip.cassette.json')
    const recorder = createRecordingFetch({ fetch: server.fetch, scrub: fakeHttpScrub, secrets: Object.values(recordedCredentials) })

    const live = await exercise(recorder.fetch, recordedCredentials)
    expect(server.channel.stockPushes).toEqual([[{ offerExternalId: 'fake-offer-1', sku: 'FAKE-SKU-1', available: 7 }]])
    expect(server.channel.statusUpdates).toEqual([{ orderExternalId: 'fake-order-1', status: 'shipped' }])
    await recorder.save(file)
    await server.close()
    server = null

    const text = await readFile(file, 'utf8')
    for (const token of [recordedCredentials.clientSecret, 'fake_session', 'Bearer ey', '44051401359', '600 100 200', 'john.test@example.com', 'John']) {
      expect(text).not.toContain(token)
    }
    const cassette = await loadCassette(file)
    expect(cassette.interactions).toHaveLength(8)
    for (const { request, response } of cassette.interactions) {
      expect(Object.keys(request.headers).sort()).toEqual(request.method === 'GET' ? ['accept'] : ['accept', 'content-type'])
      expect(response.headers).not.toHaveProperty('set-cookie')
    }
    const token = cassette.interactions[0]!
    expect(token.request.body).toEqual({ text: `grant_type=client_credentials&client_id=%5Bscrubbed%5D&client_secret=%5Bscrubbed%5D` })
    expect(token.response.body).toEqual({ json: { access_token: SCRUBBED, token_type: 'Bearer', expires_in: 3600 } })
    // The token echoed inside a link is gone too.
    expect((cassette.interactions[1]!.response.body as { json: { links: { self: string } } }).json.links.self).toContain('access_token=[scrubbed]')
    await assertNoSecrets(file)

    // Replayed with other credentials, offline: the same Offers, the same Orders with stable fake Buyer data.
    const replay = createReplayFetch(cassette, { scrub: fakeHttpScrub, secrets: Object.values(replayCredentials) })
    const replayed = await exercise(replay.fetch)
    expect(replayed.offers).toEqual(live.offers)
    expect(replayed.orders.items.map((order) => order.externalId)).toEqual(live.orders.items.map((order) => order.externalId))
    expect(replayed.orders.items[0]!.lines).toEqual(live.orders.items[0]!.lines)
    expect(replayed.orders.items[0]!.buyer).toEqual({ name: 'scrubbed-1 scrubbed-2', email: 'person-1@example.com', phone: '+00000000001', login: 'scrubbed-3' })
    // The same Buyer on another Order gets the same fakes.
    expect(replayed.orders.items[1]!.buyer).toEqual(replayed.orders.items[0]!.buyer)
    expect(replay.misses).toEqual([])
    expect(replay.unused()).toEqual([])
  })

  it('refuses to write a recording whose personal data the connector did not declare', async () => {
    server = await startFakeHttpServer()
    dir = await mkdtemp(join(tmpdir(), 'hanza-cassette-'))
    const file = join(dir, 'leaky.cassette.json')
    const recorder = createRecordingFetch({ fetch: server.fetch })
    await exercise(recorder.fetch, recordedCredentials)

    const error = await recorder.save(file).catch((caught: Error) => caught)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/\[pesel\]/)
    expect((error as Error).message).not.toContain('44051401359')
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('maps a 401 from the token endpoint to auth_expired, live and replayed', async () => {
    server = await startFakeHttpServer()
    const recorder = createRecordingFetch({ fetch: server.fetch, scrub: fakeHttpScrub })
    const wrong = { ...recordedCredentials, clientSecret: 'not-the-secret' }
    await expect(connector.capabilities['orders.pull']!(context(recorder.fetch, wrong), null)).rejects.toMatchObject({ kind: 'auth_expired' })
    const replay = createReplayFetch(recorder.cassette(), { scrub: fakeHttpScrub })
    await expect(connector.capabilities['orders.pull']!(context(replay.fetch, { ...wrong, clientSecret: 'other-wrong' }), null)).rejects.toMatchObject({
      kind: 'auth_expired',
    })
  })
})
