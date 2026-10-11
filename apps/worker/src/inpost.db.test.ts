import { createFakeChannel } from '@hanza/connector-fake'
import { inpostConnector } from '@hanza/connector-inpost'
import { conformanceCassette, inpostMatch, inpostScrub, recordedConformance, unauthorizedCassette } from '@hanza/connector-inpost/testing'
import type { Order } from '@hanza/connector-sdk'
import { isRecording, openCassette, withFetch, type OpenedCassette } from '@hanza/connector-sdk/testing'
import {
  addConnection,
  getOrder,
  getShipmentLabel,
  importOrder,
  jobs,
  listOrderShipments,
  listShippingConnections,
  requestShipment,
  shipmentsCreateRef,
  shipmentsTrackRef,
  type Actor,
  type Context,
  type ShipmentInput,
} from '@hanza/core'
import { createTestContext, createTestOrganization, type TestContext } from '@hanza/core/testing'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

const databaseUrl = inject('hanzaTestDatabaseUrl')
const user: Actor = { type: 'user', userId: 'user-1' }

// The tokens of the two Connections. The cassettes never hold a token, and a replay does not compare headers: the
// token only tells the test's `fetch` which cassette a request belongs to, as InPost would tell by looking at it.
const TOKEN = 'replay-token-00000000'
const REFUSED_TOKEN = 'a-token-inpost-does-not-know'

// The recorded shipment, the one InPost made for the conformance run.
const RECORDED_SHIPMENT = '14588109'
// An id of ShipX's own form that no account of the sandbox has; the conformance cassette tracked it beside the real one.
const UNKNOWN_SHIPMENT = '999999999999'

interface Sent {
  method: string
  /** Path and query, without the time the search starts at (a recording sets it to "now"; a replay does not compare it). */
  target: string
  token: string | null
}

function receiverOrder(externalId: string): Order {
  // The cassette's receiver, as the conformance test sends it: the same name, e-mail and phone scrub to the same placeholders.
  const phone = '111222333'
  return {
    externalId,
    placedAt: '2026-10-10T08:00:00Z',
    payment: 'prepaid',
    total: { amount: '25.00', currency: 'PLN' },
    buyer: { name: 'Jan Kowalski', email: 'jan.kowalski@example.com', phone, login: 'jan_kowalski' },
    shippingAddress: { name: 'Jan Kowalski', company: null, street: 'ul. Testowa 1', postalCode: '30-001', city: 'Krakow', countryCode: 'PL', phone, taxId: null },
    billingAddress: null,
    lines: [{ externalId: 'l1', offerExternalId: null, sku: null, name: 'Ceramic mug', quantity: 1, unitPrice: { amount: '25.00', currency: 'PLN' } }],
    facts: [],
  }
}

// The InPost connector run by the real jobs on the cassettes recorded from InPost's sandbox (`conformance` and
// `conformance-unauthorized`, see packages/connectors/inpost/AGENTS.md, "Fixtures"): no network. Every recorded answer
// is served once (`inpostMatch`), so a request the recording did not make, above all a second POST of one Shipment,
// fails the test.
//
// Not covered, because no recording holds it (the hand-written scenario cassettes are not recordings of InPost, and
// the connector's own tests run them): the courier service and cash on delivery (the sandbox account has no company
// data), any status after `confirmed` (the sandbox moves no parcel, so no Order is shipped and no `shipment_conflict`
// can arise), the listing's lag, a cancel (the connector has none) and a search that takes more than one page.
describe.skipIf(!databaseUrl || isRecording())('InPost through the engine (real Postgres, in-memory queue, replayed ShipX API)', () => {
  let ctx: TestContext
  let accepted: OpenedCassette
  let refused: OpenedCassette
  let org: string
  let channelId: string
  let inpostId: string
  let refusedInpostId: string
  const sent: Sent[] = []
  const orders: Record<'shipped' | 'unknown' | 'refused' | 'badToken' | 'badTrack', string> = { shipped: '', unknown: '', refused: '', badToken: '', badTrack: '' }
  // The next answer to a POST that is dropped on its way back: InPost made the shipment, the worker never heard.
  const lost = { posts: 0 }
  // A cassette scrubs a reference to `scrubbed-N`, and ShipX's answers carry the same placeholder, which the connector
  // compares with the reference it sent. A Shipment's id is a fresh UUID, so the connector is given the recorded
  // placeholder of its Shipment instead, as the conformance test sends it.
  const references = new Map<string, string>()
  let recorded: Awaited<ReturnType<typeof recordedConformance>>

  beforeAll(async () => {
    recorded = await recordedConformance(conformanceCassette)
    accepted = await openCassette(conformanceCassette, { scrub: inpostScrub, match: inpostMatch, secrets: [TOKEN] })
    refused = await openCassette(unauthorizedCassette, { scrub: inpostScrub, match: inpostMatch, secrets: [REFUSED_TOKEN] })

    const watching: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      url.searchParams.delete('created_at_gteq')
      const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? null
      sent.push({ method: request.method, target: `${url.pathname}${url.search}`, token })
      const response = await (token === REFUSED_TOKEN ? refused : accepted).fetch(request)
      if (request.method === 'POST' && lost.posts > 0) {
        lost.posts--
        throw new TypeError('fetch failed')
      }
      return response
    }
    const replayed = withFetch(inpostConnector, watching)
    const { capabilities } = replayed
    const inpost = {
      ...replayed,
      capabilities: {
        ...capabilities,
        'shipments.create': (callContext: Parameters<NonNullable<typeof capabilities['shipments.create']>>[0], request: Parameters<NonNullable<typeof capabilities['shipments.create']>>[1]) =>
          capabilities['shipments.create']!(callContext, { ...request, reference: references.get(request.reference) ?? request.reference }),
        // The conformance run asked for these two ids in this order; the core hands them over in the order of its own
        // Shipment ids, which are random.
        'shipments.track': (callContext: Parameters<NonNullable<typeof capabilities['shipments.track']>>[0], externalIds: string[]) =>
          capabilities['shipments.track']!(callContext, [...externalIds].sort()),
      },
    } as typeof inpostConnector

    ctx = createTestContext({ databaseUrl: databaseUrl!, connectors: [createFakeChannel().connector, inpost] })
    org = await createTestOrganization(ctx.db)
    channelId = (await addConnection(ctx, org, { connectorId: 'fake', name: 'Test channel', config: { failMode: 'none' }, credentials: { apiKey: 'test' } }, user)).connectionId
    const config = { environment: 'sandbox', shipxOrganizationId: recorded.organizationId }
    inpostId = (await addConnection(ctx, org, { connectorId: 'inpost', name: 'InPost', config, credentials: { apiToken: TOKEN } }, user)).connectionId
    refusedInpostId = (await addConnection(ctx, org, { connectorId: 'inpost', name: 'InPost, revoked token', config, credentials: { apiToken: REFUSED_TOKEN } }, user)).connectionId
    await drain()

    for (const key of Object.keys(orders) as Array<keyof typeof orders>) {
      orders[key] = (await importOrder(ctx, org, channelId, receiverOrder(`inpost-${key}`))).orderId
    }
  })

  afterAll(async () => {
    await accepted?.close()
    await refused?.close()
    await ctx?.db.$disconnect()
  })

  async function drain(options?: { maxJobs?: number }) {
    return ctx.queue.drain(ctx, jobs, options)
  }

  /** The queue is down right after commit: every enqueue throws, so a Shipment stays as the request left it. */
  function queueDown(): Context {
    return {
      ...ctx,
      queue: {
        ...ctx.queue,
        enqueue: async () => {
          throw new Error('Redis unavailable')
        },
      },
    }
  }

  const locker = (connectionId: string, pointId: string): ShipmentInput => ({
    connectionId,
    service: 'inpost_locker_standard',
    parcel: { preset: 'small' },
    destination: { type: 'pickup_point', pointId },
    cashOnDelivery: null,
  })

  const shipmentsOf = (orderId: string) => listOrderShipments(ctx, org, orderId)
  const row = (shipmentId: string) => ctx.db.shipment.findFirstOrThrow({ where: { id: shipmentId, organizationId: org } })
  const health = async (connectionId: string) => (await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId, organizationId: org } })).health
  const stream = (connectionId: string, name: 'shipments_create' | 'shipments_track') =>
    ctx.db.syncState.findFirst({ where: { organizationId: org, connectionId, stream: name } })
  const posts = () => sent.filter((request) => request.method === 'POST' && request.token === TOKEN)
  const searches = () => sent.filter((request) => request.method === 'GET' && request.token === TOKEN && request.target.includes('sort_by=created_at'))

  /** Every check the organization's Shipments are owed becomes overdue, as if their interval had passed. */
  async function timePasses() {
    await ctx.db.$executeRaw`
      UPDATE "shipment" SET "nextCheckAt" = now() - interval '1 second'
      WHERE "organizationId" = ${org} AND "nextCheckAt" IS NOT NULL`
  }

  let shippedId = ''
  let unknownId = ''

  it('1. the InPost Connection is offered for Shipments, with its two services and no cancel', async () => {
    const connections = await listShippingConnections(ctx, org)
    expect(connections.map(({ id, connectorId, canCancel }) => ({ id, connectorId, canCancel }))).toEqual(
      expect.arrayContaining([
        { id: inpostId, connectorId: 'inpost', canCancel: false },
        { id: refusedInpostId, connectorId: 'inpost', canCancel: false },
      ]),
    )
    expect(connections.find(({ id }) => id === inpostId)!.services.map(({ id }) => id)).toEqual(['inpost_locker_standard', 'inpost_courier_standard'])
    expect(sent).toEqual([])
  })

  it('2. a requested Shipment is searched for, then posted once; the answer is lost on its way back', async () => {
    shippedId = (await requestShipment(ctx, org, orders.shipped, locker(inpostId, recorded.targetPoint), user)).shipmentId
    references.set(shippedId, recorded.reference)
    expect(ctx.queue.waiting.map((job) => job.name)).toEqual(['shipments.create'])
    lost.posts = 1
    // The queue retries the failed job at once; the retry does not reach InPost while the create lease holds.
    const drained = await drain()
    expect(drained).toMatchObject({ ran: 2, failed: [] })

    // InPost made the shipment (the cassette served the POST) and Hanza never heard of it.
    expect(sent.map((request) => request.method)).toEqual(['GET', 'POST'])
    expect(sent[0]!.target).toBe(`/v1/organizations/${recorded.organizationId}/shipments?sort_by=created_at&sort_order=asc&page=1&per_page=100`)
    expect(sent[1]!.target).toBe(`/v1/organizations/${recorded.organizationId}/shipments`)
    expect(await shipmentsOf(orders.shipped)).toMatchObject([{ id: shippedId, status: 'requested', externalId: null }])
    expect(await row(shippedId)).toMatchObject({ createOutcomeUnknown: true, createAttempts: 1 })
    expect(await stream(inpostId, 'shipments_create')).toMatchObject({ lastErrorKind: 'transient' })
    expect(await health(inpostId)).toBe('failing')
  })

  it('3. once the delay is over the create is asked again, finds the shipment by its reference and posts no second one', async () => {
    await ctx.db.$executeRaw`
      UPDATE "shipment" SET "createLeaseUntil" = now() - interval '1 second', "nextCheckAt" = now() - interval '1 second'
      WHERE "id" = ${shippedId} AND "organizationId" = ${org}`
    await ctx.queue.enqueue(shipmentsCreateRef, { organizationId: org, shipmentId: shippedId })
    // Only the create: the check of the Shipment that follows it is run by the next step.
    expect(await drain({ maxJobs: 1 })).toEqual({ ran: 1, failed: [] })

    // The search now lists the shipment, bought by InPost meanwhile.
    expect(sent.map((request) => request.method)).toEqual(['GET', 'POST', 'GET'])
    expect(posts()).toHaveLength(1)
    expect(searches()).toHaveLength(2)
    expect(await shipmentsOf(orders.shipped)).toMatchObject([
      {
        id: shippedId,
        status: 'ready',
        externalId: RECORDED_SHIPMENT,
        carrierStatus: 'confirmed',
        trackingNumber: expect.stringMatching(/^\d{24}$/),
        serviceName: 'InPost Paczkomat 24/7',
        hasLabel: false,
        canCancel: false,
      },
    ])
    expect(await row(shippedId)).toMatchObject({ createOutcomeUnknown: false, createAttempts: 2 })
    expect(await stream(inpostId, 'shipments_create')).toMatchObject({ lastResult: { created: 1 }, lastErrorKind: null })
    expect(await health(inpostId)).toBe('ok')
    expect(ctx.queue.waiting.map((job) => job.name)).toEqual(['shipments.track'])
  })

  it('4. the track job follows both Shipments in one call, fetches the Label and seals it; a shipment InPost does not list is left as it is', async () => {
    // A second Shipment of the Connection that InPost has no record of: the conformance run tracked such an id beside
    // the real one. It is placed as the create job would leave it, without a job running for it.
    unknownId = (await requestShipment(queueDown(), org, orders.unknown, locker(inpostId, recorded.targetPoint), user)).shipmentId
    await ctx.db.$executeRaw`
      UPDATE "shipment"
      SET "status" = 'pending', "externalId" = ${UNKNOWN_SHIPMENT}, "carrierStatus" = 'created', "createAttempts" = 1
      WHERE "id" = ${unknownId} AND "organizationId" = ${org}`
    await timePasses()
    const before = sent.length

    expect(await drain()).toEqual({ ran: 1, failed: [] })

    expect(sent.slice(before).map((request) => `${request.method} ${request.target}`)).toEqual([
      `GET /v1/organizations/${recorded.organizationId}/shipments?id=${RECORDED_SHIPMENT}%2C${UNKNOWN_SHIPMENT}&page=1&per_page=100`,
      `GET /v1/shipments/${RECORDED_SHIPMENT}/label?format=pdf&type=A6`,
    ])
    expect(await shipmentsOf(orders.shipped)).toMatchObject([
      { id: shippedId, status: 'ready', carrierStatus: 'confirmed', trackingNumber: expect.stringMatching(/^\d{24}$/), hasLabel: true },
    ])
    expect(await stream(inpostId, 'shipments_track')).toMatchObject({ lastResult: { checked: 2, changed: 0, labels: 1, cancelled: 0 }, lastErrorKind: null })

    // The Label is a PDF, sealed in the row and readable through the service.
    const label = await getShipmentLabel(ctx, org, shippedId)
    expect(label).toMatchObject({ contentType: 'application/pdf', extension: 'pdf' })
    expect(Buffer.from(label!.data).toString('latin1')).toMatch(/^%PDF-1\.4/)
    const stored = await row(shippedId)
    expect(stored.label).toMatch(/^v1:/)
    expect(stored.label).not.toContain(Buffer.from(label!.data).toString('base64'))

    // InPost left the unknown id out of its answer: nothing about it changes, and it is asked about again later.
    expect(await shipmentsOf(orders.unknown)).toMatchObject([{ id: unknownId, status: 'pending', externalId: UNKNOWN_SHIPMENT, carrierStatus: 'created', hasLabel: false }])
    expect((await row(unknownId)).nextCheckAt).not.toBeNull()
    // Neither Shipment has left the warehouse: the Order is where it was.
    expect(await getOrder(ctx, org, orders.shipped)).toMatchObject({ phase: 'new' })
    expect(posts()).toHaveLength(1)
  })

  it("5. a locker InPost refuses fails the Shipment with ShipX's code, after a search that found no earlier one", async () => {
    const { shipmentId } = await requestShipment(ctx, org, orders.refused, locker(inpostId, 'XXX000X'), user)
    references.set(shipmentId, recorded.rejectedReference)
    const before = sent.length
    expect(await drain()).toEqual({ ran: 1, failed: [] })

    expect(sent.slice(before).map((request) => request.method)).toEqual(['GET', 'POST'])
    expect(await shipmentsOf(orders.refused)).toMatchObject([
      { id: shipmentId, status: 'failed', failureCode: 'target_point.does_not_exist', externalId: null, hasLabel: false },
    ])
    expect(await row(shipmentId)).toMatchObject({ nextCheckAt: null, createOutcomeUnknown: false })
    expect(await stream(inpostId, 'shipments_create')).toMatchObject({ lastResult: { rejected: 1 }, lastErrorKind: null })
    // A refusal is the request's, not the Connection's.
    expect(await health(inpostId)).toBe('ok')
    // No parcel was made, so nothing is wrong with the Order.
    expect(await getOrder(ctx, org, orders.refused)).toMatchObject({ phase: 'new' })
    expect((await getOrder(ctx, org, orders.refused))!.attentionReasons).not.toContain('shipment_conflict')
    expect(posts()).toHaveLength(2)
  })

  it('6. a token InPost refuses marks the Connection as needing sign-in, on the create and on the track', async () => {
    const { shipmentId } = await requestShipment(ctx, org, orders.badToken, locker(refusedInpostId, recorded.targetPoint), user)
    const before = sent.length
    const drained = await drain()
    expect(drained.failed).toHaveLength(1)
    expect(drained.failed[0]).toMatchObject({ name: 'shipments.create', error: { name: 'PermanentJobError' } })

    // The search came back 401 and nothing was posted.
    expect(sent.slice(before).map((request) => `${request.method} ${request.target}`)).toEqual([
      `GET /v1/organizations/${recorded.organizationId}/shipments?sort_by=created_at&sort_order=asc&page=1&per_page=100`,
    ])
    expect(await health(refusedInpostId)).toBe('auth_expired')
    expect(await stream(refusedInpostId, 'shipments_create')).toMatchObject({ lastErrorKind: 'auth_expired' })
    expect(await shipmentsOf(orders.badToken)).toMatchObject([{ id: shipmentId, status: 'requested', externalId: null }])
    // The other Connection is not touched.
    expect(await health(inpostId)).toBe('ok')

    // A Shipment this Connection made earlier is followed with the same token: the track is answered 401 as well.
    const followed = (await requestShipment(queueDown(), org, orders.badTrack, locker(refusedInpostId, recorded.targetPoint), user)).shipmentId
    await ctx.db.$executeRaw`
      UPDATE "shipment" SET "status" = 'pending', "externalId" = ${RECORDED_SHIPMENT}, "carrierStatus" = 'created', "nextCheckAt" = now() - interval '1 second'
      WHERE "id" = ${followed} AND "organizationId" = ${org}`
    await ctx.queue.enqueue(shipmentsTrackRef, { organizationId: org, connectionId: refusedInpostId })
    const tracked = await drain()
    expect(tracked.failed).toHaveLength(1)
    expect(tracked.failed[0]).toMatchObject({ name: 'shipments.track', error: { name: 'PermanentJobError' } })
    expect(sent.at(-1)).toMatchObject({ method: 'GET', target: `/v1/organizations/${recorded.organizationId}/shipments?id=${RECORDED_SHIPMENT}&page=1&per_page=100`, token: REFUSED_TOKEN })
    expect(await stream(refusedInpostId, 'shipments_track')).toMatchObject({ lastErrorKind: 'auth_expired' })
    expect(await health(refusedInpostId)).toBe('auth_expired')
    expect(await shipmentsOf(orders.badTrack)).toMatchObject([{ id: followed, status: 'pending', externalId: RECORDED_SHIPMENT }])
  })

  it('7. every recorded answer was served once, and nothing outside the recordings was asked', () => {
    expect(accepted.misses).toEqual([])
    expect(refused.misses).toEqual([])
    expect(accepted.unused()).toEqual([])
    expect(refused.unused()).toEqual([])
  })
})
