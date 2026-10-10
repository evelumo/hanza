import { createFakeChannel, type FakeChannel } from '@hanza/connector-fake'
import {
  addConnection,
  cancelShipment,
  createProduct,
  getAvailability,
  getOrder,
  getShipmentLabel,
  jobs,
  listOrderShipments,
  listShippingConnections,
  requestShipment,
  resolveAttention,
  syncTickRef,
  type Actor,
  type Context,
  type ShipmentInput,
} from '@hanza/core'
import { createTestCarrier, createTestContext, createTestOrganization, TEST_CARRIER_SERVICES, type TestCarrier, type TestContext } from '@hanza/core/testing'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

const databaseUrl = inject('hanzaTestDatabaseUrl')
const user: Actor = { type: 'user', userId: 'user-1' }

// The registered jobs, a real database and an in-memory queue, with the fake Channel selling and a scripted Carrier
// shipping: a Shipment from the request to the Order it ships.
describe.skipIf(!databaseUrl)('shipments end to end (real Postgres, in-memory queue, fake Channel, test Carrier)', () => {
  let ctx: TestContext
  let fake: FakeChannel
  let carrier: TestCarrier
  let org: string
  let channelId: string
  let carrierId: string
  let productId: string

  beforeAll(async () => {
    fake = createFakeChannel()
    carrier = createTestCarrier()
    ctx = createTestContext({ databaseUrl: databaseUrl!, connectors: [fake.connector, carrier.connector] })
    org = await createTestOrganization(ctx.db)
    productId = (await createProduct(ctx, org, { sku: 'FAKE-SKU-1', name: 'FAKE-SKU-1', stock: 5 }, user)).productId
    const settings = { name: 'Test channel', config: { failMode: 'none' }, credentials: { apiKey: 'test' } }
    channelId = (await addConnection(ctx, org, { connectorId: 'fake', ...settings }, user)).connectionId
    carrierId = (await addConnection(ctx, org, { connectorId: 'test-carrier', name: 'Test carrier', config: {}, credentials: {} }, user)).connectionId
    await drain()
  })

  afterAll(async () => {
    await ctx?.db.$disconnect()
  })

  async function drain() {
    const result = await ctx.queue.drain(ctx, jobs)
    expect(result.failed).toEqual([])
    expect(ctx.queue.waiting).toEqual([])
    return result
  }

  /** The tick reads every Connection in the shared test database: keep only this organization's jobs. */
  async function tick() {
    await ctx.queue.enqueue(syncTickRef, {})
    expect(await ctx.queue.drain(ctx, jobs, { maxJobs: 1 })).toEqual({ ran: 1, failed: [] })
    const own = ctx.queue.waiting.filter((job) => (job.payload as { organizationId?: string }).organizationId === org)
    ctx.queue.waiting.splice(0, ctx.queue.waiting.length, ...own)
    const names = own.map((job) => job.name)
    await drain()
    return names
  }

  /** Every check the organization's Shipments are owed becomes overdue, as if their interval had passed. */
  async function timePasses() {
    await ctx.db.$executeRaw`
      UPDATE "shipment" SET "nextCheckAt" = now() - interval '1 second'
      WHERE "organizationId" = ${org} AND "nextCheckAt" IS NOT NULL`
  }

  /** The queue is down right after commit: every enqueue throws. */
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

  const locker = (pointId = 'KRA010'): ShipmentInput => ({
    connectionId: carrierId,
    service: TEST_CARRIER_SERVICES.locker,
    parcel: { preset: 'small' },
    destination: { type: 'pickup_point', pointId },
    cashOnDelivery: null,
  })

  async function orderId(externalId: string) {
    return (await ctx.db.order.findFirstOrThrow({ where: { organizationId: org, connectionId: channelId, externalId } })).id
  }

  const shipmentsOf = async (externalId: string) => listOrderShipments(ctx, org, await orderId(externalId))
  const available = async () => (await getAvailability(ctx.db, org, [productId])).get(productId)
  const stream = (connectionId: string, name: 'shipments_create' | 'shipments_track') =>
    ctx.db.syncState.findFirst({ where: { organizationId: org, connectionId, stream: name } })
  const health = async (connectionId: string) => (await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId, organizationId: org } })).health

  it('1. the Carrier Connection is offered for Shipments, with its services', async () => {
    expect(await listShippingConnections(ctx, org)).toEqual([
      {
        id: carrierId,
        name: 'Test carrier',
        connectorId: 'test-carrier',
        connectorName: 'Test carrier',
        health: 'unknown',
        services: carrier.connector.shipping!.services,
        canCancel: true,
      },
    ])
    expect(await available()).toEqual({ stock: 5, reserved: 2, available: 3 })
  })

  it('2. a requested Shipment is created at the Carrier by the job', async () => {
    const id = await orderId('fake-order-1')
    const { shipmentId } = await requestShipment(ctx, org, id, locker(), user)
    expect(ctx.queue.waiting.map((job) => job.name)).toEqual(['shipments.create'])
    await drain()

    const at = carrier.byReference(shipmentId)!
    expect(await shipmentsOf('fake-order-1')).toMatchObject([
      { id: shipmentId, status: 'pending', externalId: at.externalId, serviceName: 'Test locker', parcel: { preset: 'small' }, hasLabel: false, canCancel: true },
    ])
    expect(carrier.calls.create).toHaveLength(1)
    expect(carrier.calls.create[0]).toMatchObject({ reference: shipmentId, destination: { type: 'pickup_point', pointId: 'KRA010' } })
    expect(await stream(carrierId, 'shipments_create')).toMatchObject({ lastResult: { created: 1 }, lastErrorKind: null })
    expect(await health(carrierId)).toBe('ok')
  })

  it('3. the tick has it tracked once it is due; a confirmed Shipment gets its Label, sealed', async () => {
    // Checked moments ago: this tick leaves it alone.
    expect(await tick()).not.toContain('shipments.track')
    expect(carrier.calls.track).toEqual([])

    const [shipment] = await shipmentsOf('fake-order-1')
    carrier.advance(shipment!.externalId!, 'ready', 'confirmed')
    await timePasses()
    expect(await tick()).toContain('shipments.track')

    expect(carrier.calls.track).toEqual([[shipment!.externalId]])
    expect(await shipmentsOf('fake-order-1')).toMatchObject([
      { status: 'ready', carrierStatus: 'confirmed', trackingNumber: `TRACK-${shipment!.externalId}`, hasLabel: true, handedOverAt: null },
    ])
    const label = await getShipmentLabel(ctx, org, shipment!.id)
    expect(label).toMatchObject({ contentType: 'application/pdf', extension: 'pdf' })
    expect(label!.data).toEqual(carrier.label.data)
    const row = await ctx.db.shipment.findFirstOrThrow({ where: { id: shipment!.id } })
    expect(row.label).toMatch(/^v1:/)
    expect(row.label).not.toContain(Buffer.from(carrier.label.data).toString('base64'))
    expect(await stream(carrierId, 'shipments_track')).toMatchObject({ lastResult: { checked: 1, changed: 1, labels: 1, cancelled: 0 } })

    // A Label is not a parcel the Carrier has: the Order is where it was.
    expect(await getOrder(ctx, org, await orderId('fake-order-1'))).toMatchObject({ phase: 'new' })
    expect(await available()).toEqual({ stock: 5, reserved: 2, available: 3 })
  })

  it('4. the Carrier takes the parcel: the Order is shipped, its Reservation consumed, and the Channel told', async () => {
    const [shipment] = await shipmentsOf('fake-order-1')
    carrier.advance(shipment!.externalId!, 'in_transit', 'taken_by_courier')
    await timePasses()
    await tick()

    const shipped = await getOrder(ctx, org, await orderId('fake-order-1'))
    expect(shipped).toMatchObject({ phase: 'shipped', attentionReasons: [] })
    expect(shipped!.lines.map((line) => line.reservationStatus)).toEqual(['consumed'])
    expect(await available()).toEqual({ stock: 3, reserved: 0, available: 3 })
    expect(fake.statusUpdates).toContainEqual({ orderExternalId: 'fake-order-1', phase: 'shipped' })
    expect((await shipmentsOf('fake-order-1'))[0]).toMatchObject({ status: 'in_transit', canCancel: false })
    expect((await shipmentsOf('fake-order-1'))[0]!.handedOverAt).not.toBeNull()

    const change = shipped!.events.find((event) => event.type === 'order.status_changed')
    expect(change?.payload).toMatchObject({ from: 'new', to: 'shipped', cause: 'shipment', shipmentId: shipment!.id, actor: { type: 'system' } })
    // The Shipment's own trail is on the Order too.
    expect(shipped!.events.filter((event) => event.type.startsWith('shipment.')).map((event) => event.type).reverse()).toEqual([
      'shipment.requested',
      'shipment.status_changed',
      'shipment.status_changed',
      'shipment.status_changed',
    ])
  })

  it('5. a delivered Shipment is final: its Label is deleted and it is not asked about again', async () => {
    const [shipment] = await shipmentsOf('fake-order-1')
    carrier.advance(shipment!.externalId!, 'delivered', 'delivered')
    await timePasses()
    await tick()

    expect((await shipmentsOf('fake-order-1'))[0]).toMatchObject({ status: 'delivered', hasLabel: false, canCancel: false })
    expect(await getShipmentLabel(ctx, org, shipment!.id)).toBeNull()
    expect(await available()).toEqual({ stock: 3, reserved: 0, available: 3 })

    const asked = carrier.calls.track.length
    await timePasses()
    expect(await tick()).not.toContain('shipments.track')
    expect(carrier.calls.track).toHaveLength(asked)
  })

  it('6. a request whose enqueue was lost is picked up by the tick; an Order that cannot ship gets shipment_conflict', async () => {
    // fake-order-4 has an Unmatched line.
    const id = await orderId('fake-order-4')
    const { shipmentId } = await requestShipment(queueDown(), org, id, locker('WAW22A'), user)
    expect(ctx.queue.waiting).toEqual([])
    expect((await shipmentsOf('fake-order-4'))[0]).toMatchObject({ status: 'requested', externalId: null })

    expect(await tick()).toContain('shipments.create')
    const at = carrier.byReference(shipmentId)!
    expect((await shipmentsOf('fake-order-4'))[0]).toMatchObject({ status: 'pending', externalId: at.externalId })

    carrier.advance(at.externalId, 'in_transit')
    await timePasses()
    await tick()
    expect(await getOrder(ctx, org, id)).toMatchObject({ phase: 'new', attentionReasons: ['unmatched_line', 'shipment_conflict'] })
    expect((await shipmentsOf('fake-order-4'))[0]!.handedOverAt).not.toBeNull()
    await resolveAttention(ctx, org, id, user)
    expect(await getOrder(ctx, org, id)).toMatchObject({ attentionReasons: ['unmatched_line'] })
  })

  it('7. a pickup point the Carrier refuses fails the Shipment; a cancel is put to the Carrier by the track job', async () => {
    const id = await orderId('fake-order-3')
    carrier.rejectWith = 'target_point.does_not_exist'
    const refused = await requestShipment(ctx, org, id, locker('NOPE00'), user)
    await drain()
    carrier.rejectWith = null
    expect((await shipmentsOf('fake-order-3'))[0]).toMatchObject({ id: refused.shipmentId, status: 'failed', failureCode: 'target_point.does_not_exist' })

    const second = await requestShipment(ctx, org, id, locker(), user)
    await drain()
    expect(await cancelShipment(ctx, org, second.shipmentId, user)).toEqual({ outcome: 'requested' })
    await drain()
    expect(carrier.calls.cancel).toEqual([carrier.byReference(second.shipmentId)!.externalId])
    expect((await shipmentsOf('fake-order-3'))[1]).toMatchObject({ id: second.shipmentId, status: 'cancelled', canCancel: false })
    expect(await getOrder(ctx, org, id)).toMatchObject({ phase: 'new' })
  })

  it('8. a create whose answer is lost is not repeated by the queue; the tick asks again once the delay is over and gets the same Shipment', async () => {
    const id = await orderId('fake-order-3')
    const asked = carrier.calls.create.length
    const row = async () => (await shipmentsOf('fake-order-3')).at(-1)!
    // The Carrier makes the Shipment and its answer never arrives.
    carrier.loseAnswers = 1
    const { shipmentId } = await requestShipment(ctx, org, id, locker(), user)

    // The queue retries the failed job at once (BullMQ: seconds later). The retry does not reach the Carrier.
    const drained = await drain()
    expect(drained.ran).toBe(2)
    expect(carrier.calls.create).toHaveLength(asked + 1)
    const made = carrier.byReference(shipmentId)!
    expect(await row()).toMatchObject({ id: shipmentId, status: 'requested', externalId: null, mayExistAtCarrier: true })
    expect(await stream(carrierId, 'shipments_create')).toMatchObject({ lastErrorKind: 'transient' })
    expect(await health(carrierId)).toBe('failing')
    // A second click meanwhile buys nothing.
    await expect(requestShipment(ctx, org, id, locker(), user)).rejects.toMatchObject({ code: 'shipment_already_requested' })

    // Nor does the tick take it while the delay runs.
    expect(await tick()).not.toContain('shipments.create')
    expect(carrier.calls.create).toHaveLength(asked + 1)

    // The delay is over: the tick has it asked for again, and the Carrier returns the Shipment the lost call made.
    await ctx.db.$executeRaw`
      UPDATE "shipment" SET "createLeaseUntil" = now() - interval '1 second', "nextCheckAt" = now() - interval '1 second'
      WHERE "id" = ${shipmentId} AND "organizationId" = ${org}`
    expect(await tick()).toContain('shipments.create')
    expect(carrier.calls.create).toHaveLength(asked + 2)
    expect(carrier.calls.create.filter((request) => request.reference === shipmentId)).toHaveLength(2)
    expect([...carrier.shipments.values()].filter((shipment) => shipment.reference === shipmentId)).toHaveLength(1)
    expect(await row()).toMatchObject({ id: shipmentId, status: 'pending', externalId: made.externalId, mayExistAtCarrier: false })
    expect(await health(carrierId)).toBe('ok')
  })
})
