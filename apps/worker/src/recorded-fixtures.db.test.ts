import { createFakeHttpConnector } from '@hanza/connector-fake'
import { fakeHttpScrub, startFakeHttpServer } from '@hanza/connector-fake/http-server'
import { openCassette, withFetch, type OpenedCassette } from '@hanza/connector-sdk/testing'
import { addConnection, changeOrderStatus, createProduct, jobs, type Actor } from '@hanza/core'
import { createTestContext, createTestOrganization, type TestContext } from '@hanza/core/testing'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

const databaseUrl = inject('hanzaTestDatabaseUrl')
const user: Actor = { type: 'user', userId: 'user-1' }
const credentials = { clientId: 'fake-http-client', clientSecret: 'fake-http-client-secret' }

// The engine runs an HTTP connector on a recorded cassette: no server, no network. Record it again with
// `HANZA_RECORD_FIXTURES=1` (see packages/connectors/README.md); the recording talks to the in-process fake Channel server.
describe.skipIf(!databaseUrl)('sync engine on recorded fixtures (real Postgres, replayed HTTP connector)', () => {
  let ctx: TestContext
  let cassette: OpenedCassette
  let org: string
  let connectionId: string
  const products: Record<string, string> = {}
  const sent: Array<{ method: string; path: string; body: unknown }> = []

  beforeAll(async () => {
    cassette = await openCassette(new URL('./fixtures/fake-http-engine.cassette.json', import.meta.url), {
      scrub: fakeHttpScrub,
      secrets: Object.values(credentials),
      recording: async () => {
        const server = await startFakeHttpServer(credentials)
        return { fetch: server.fetch, close: server.close }
      },
    })
    // What the connector sent, to assert on pushes without a Channel to ask.
    const spy: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      const text = await request.clone().text()
      sent.push({ method: request.method, path: new URL(request.url).pathname, body: text && request.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null })
      return cassette.fetch(request)
    }
    ctx = createTestContext({ databaseUrl: databaseUrl!, connectors: [withFetch(createFakeHttpConnector(), spy)] })
    org = await createTestOrganization(ctx.db)
  })

  afterAll(async () => {
    await cassette?.close()
    await ctx?.db.$disconnect()
  })

  async function drain() {
    const result = await ctx.queue.drain(ctx, jobs)
    expect(result.failed).toEqual([])
    return result
  }

  function lastPushed(offerId: string): number | undefined {
    const pushes = sent.filter((request) => request.method === 'PUT' && request.path === '/stock')
    for (const { body } of pushes.reverse()) {
      const item = (body as { items: Array<{ offerId: string; quantity: number }> }).items.find((candidate) => candidate.offerId === offerId)
      if (item) return item.quantity
    }
    return undefined
  }

  const order = (externalId: string) =>
    ctx.db.order.findFirstOrThrow({
      where: { organizationId: org, connectionId, externalId },
      include: { lines: { orderBy: { externalId: 'asc' }, include: { reservation: true } } },
    })

  it('imports Offers and Orders from the cassette and pushes Available back through it', async () => {
    for (const [sku, stock] of [['FAKE-SKU-1', 5], ['FAKE-SKU-2', 1], ['FAKE-SKU-3', 0]] as const) {
      products[sku] = (await createProduct(ctx, org, { sku, name: sku, stock }, user)).productId
    }
    connectionId = (await addConnection(ctx, org, { connectorId: 'fake-http', name: 'Recorded channel', config: {}, credentials }, user)).connectionId
    await drain()

    const connection = await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId, organizationId: org } })
    expect(connection.health).toBe('ok')
    const offers = await ctx.db.offer.findMany({ where: { organizationId: org, connectionId }, orderBy: { externalId: 'asc' } })
    expect(offers.map((offer) => [offer.externalId, offer.productId])).toEqual([
      ['fake-offer-1', products['FAKE-SKU-1']],
      ['fake-offer-2', products['FAKE-SKU-2']],
      ['fake-offer-3', products['FAKE-SKU-3']],
      ['fake-offer-4', null],
      ['fake-offer-5', null],
    ])

    expect(await ctx.db.order.count({ where: { organizationId: org } })).toBe(4)
    const first = await order('fake-order-1')
    expect(first.lines.map((line) => [line.reservation?.status, line.reservation?.units])).toEqual([['open', 2]])
    // The cancellation fact came through the recorded journal.
    expect((await order('fake-order-2')).status).toBe('cancelled')

    expect([lastPushed('fake-offer-1'), lastPushed('fake-offer-2'), lastPushed('fake-offer-3')]).toEqual([3, 1, 0])
  })

  it('pushes a status change through the cassette', async () => {
    await changeOrderStatus(ctx, org, (await order('fake-order-1')).id, 'shipped', user)
    await drain()
    expect(sent.filter((request) => request.path === '/orders/fake-order-1/status').map((request) => request.body)).toEqual([{ status: 'SENT' }])
  })

  it('served every recorded interaction and nothing else', () => {
    expect(cassette.misses).toEqual([])
    expect(cassette.unused()).toEqual([])
  })
})
