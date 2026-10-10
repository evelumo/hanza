import { TransientError, type Order } from '@hanza/connector-sdk'
import { beforeEach, describe, expect, it } from 'vitest'
import { createProduct } from '../catalog/products'
import type { Context } from '../context'
import { shipmentsCreateJob } from '../jobs/shipments-create'
import { shipmentsTrackJob } from '../jobs/shipments-track'
import { importOrder } from '../orders/import'
import { getOrder } from '../orders/queries'
import { eraseBuyerData } from '../privacy/erasure'
import { setBuyerDataRetention } from '../privacy/settings'
import { applyBuyerDataRetention } from '../privacy/sweep'
import { createTestCarrier } from '../testing/carrier'
import { createTestOrganization, type TestContext } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { addMember, buildOrder, courierShipment, createCarrierConnection, createTestConnection, createWaitPasses, jobRun, lockerShipment, orderLine, testChannel, user } from '../testing/fixtures'
import { cancelShipment } from './cancel'
import { getShipmentLabel } from './label'
import { listOrderShipments } from './queries'
import { requestShipment } from './request'
import { MAX_LABEL_BYTES } from './sealed'

const carrier = createTestCarrier({ id: 'privacy-carrier' })

// Values that appear nowhere else, so finding one anywhere means Buyer data leaked.
const secretBuyer: Pick<Order, 'buyer' | 'shippingAddress' | 'delivery'> = {
  buyer: { name: 'Zofia Brzeczyszczykiewicz', email: 'zofia.sekretna@poczta.example', phone: '+48 600 700 800', login: 'zofia_b_1987' },
  shippingAddress: {
    name: 'Bogumil Odbiorca',
    company: 'Tajna Firma',
    street: 'ul. Sekretna 17/4',
    postalCode: '22-460',
    city: 'Szczebrzeszyn',
    countryCode: 'PL',
    phone: '+48 511 222 333',
    taxId: null,
  },
  delivery: { method: 'Paczkomat InPost 24/7', pickupPoint: { id: 'SZC01M', name: 'Szczebrzeszyn Rynek' } },
}
const CONFIRMED_POINT = 'ZAM77X'
const SECRETS = [
  'Zofia', 'Brzeczyszczykiewicz', 'zofia.sekretna', 'poczta.example', '600 700 800', 'zofia_b_1987',
  'Bogumil', 'Odbiorca', 'Tajna Firma', 'Sekretna', '22-460', 'Szczebrzeszyn', '511 222 333',
  'SZC01M', 'Paczkomat', CONFIRMED_POINT,
]
const LABEL = new TextEncoder().encode('%PDF-1.7 Bogumil Odbiorca, ul. Sekretna 17/4, 22-460 Szczebrzeszyn')

function withLogCapture(ctx: TestContext): { ctx: Context; logged: Array<Record<string, unknown>> } {
  const logged: Array<Record<string, unknown>> = []
  const capture = (message: string, fields?: Record<string, unknown>) => void logged.push({ message, ...fields })
  return { ctx: { ...ctx, log: { info: capture, warn: capture, error: capture } }, logged }
}

describe.skipIf(!databaseUrl)('Shipments and Buyer data', () => {
  const context = useTestContext({ connectors: [testChannel, carrier.connector] })

  beforeEach(() => {
    carrier.failures = {}
    carrier.label = { contentType: 'application/pdf', data: LABEL }
    carrier.calls.label.length = 0
    context().queue.waiting.length = 0
  })

  async function setup() {
    const base = context()
    const { ctx, logged } = withLogCapture(base)
    const org = await createTestOrganization(base.db)
    const channelId = await createTestConnection(base, org)
    const carrierId = await createCarrierConnection(base, org, 'privacy-carrier')
    await createProduct(base, org, { sku: 'P', name: 'Product', stock: 10 }, user)
    const order = buildOrder({ lines: [orderLine('l1', { sku: 'P', quantity: 2 })], ...secretBuyer })
    const { orderId } = await importOrder(ctx, org, channelId, order)
    const enqueuedFrom = base.queue.enqueued.length

    const due = () => base.db.$executeRaw`UPDATE "shipment" SET "nextCheckAt" = now() - interval '1 second' WHERE "organizationId" = ${org} AND "nextCheckAt" IS NOT NULL`
    const create = (shipmentId: string) => shipmentsCreateJob.handler(ctx, { organizationId: org, shipmentId }, jobRun)
    const track = async () => {
      await due()
      await shipmentsTrackJob.handler(ctx, { organizationId: org, connectionId: carrierId }, jobRun)
    }
    /** Everything Hanza wrote in plaintext for this organization, and everything it logged or enqueued. */
    const written = async () => {
      const rows = (table: string) => base.db.$queryRawUnsafe<unknown[]>(`SELECT row_to_json(t) AS "row" FROM "${table}" t WHERE "organizationId" = $1`, org)
      return JSON.stringify({
        events: await rows('event_log'),
        shipments: await rows('shipment'),
        orders: await rows('order'),
        syncStates: await rows('sync_state'),
        connections: (await base.db.connection.findMany({ where: { organizationId: org }, select: { health: true, name: true } })),
        jobs: base.queue.enqueued.slice(enqueuedFrom),
        logged,
      })
    }
    return { base, ctx, logged, org, channelId, carrierId, order, orderId, create, track, due, written, enqueuedFrom }
  }

  it('Buyer data reaches the Carrier and nothing else: no Event, job payload, log line or plaintext column holds it', async () => {
    const { base, ctx, org, carrierId, orderId, create, track, written, logged, enqueuedFrom } = await setup()

    // A locker Shipment to a point the person typed, and a courier Shipment to the Order's address.
    const locker = await requestShipment(ctx, org, orderId, lockerShipment(carrierId, { destination: { type: 'pickup_point', pointId: CONFIRMED_POINT } }), user)
    const courier = await requestShipment(ctx, org, orderId, courierShipment(carrierId), user)
    // A lost answer, a failed call, then success: the failure paths log and record too.
    carrier.loseAnswers = 1
    await expect(create(locker.shipmentId)).rejects.toBeInstanceOf(TransientError)
    await createWaitPasses(base, locker.shipmentId)
    await create(locker.shipmentId)
    await create(courier.shipmentId)
    const lockerAt = carrier.byReference(locker.shipmentId)!
    const courierAt = carrier.byReference(courier.shipmentId)!

    carrier.advance(lockerAt.externalId, 'ready', 'confirmed')
    carrier.failures.label = new TransientError('no label yet')
    await track()
    carrier.failures = {}
    // A file too large to be a Label is refused with a log line, which names the Shipment and nothing of the Buyer.
    carrier.label = { contentType: 'application/pdf', data: new Uint8Array(MAX_LABEL_BYTES + 1) }
    await track()
    carrier.label = { contentType: 'application/pdf', data: LABEL }
    await track()
    await cancelShipment(ctx, org, courier.shipmentId, user)
    carrier.cancelRefusal = 'too_late'
    await track()
    carrier.cancelRefusal = null
    carrier.advance(lockerAt.externalId, 'in_transit', 'taken_by_courier')
    await track()
    carrier.advance(lockerAt.externalId, 'delivered', 'delivered')
    carrier.advance(courierAt.externalId, 'returned', 'returned_to_sender')
    await track()

    // The path did carry the Buyer data: the Carrier got it, and the panel can still read it.
    const sent = carrier.calls.create.filter((request) => [locker.shipmentId, courier.shipmentId].includes(request.reference))
    expect(sent).toHaveLength(3)
    expect(sent[0]).toMatchObject({
      receiver: { name: 'Bogumil Odbiorca', company: 'Tajna Firma', email: 'zofia.sekretna@poczta.example', phone: '+48 511 222 333' },
      destination: { type: 'pickup_point', pointId: CONFIRMED_POINT },
    })
    expect(sent[2]).toMatchObject({ destination: { type: 'address', address: secretBuyer.shippingAddress } })
    expect(await getOrder(ctx, org, orderId)).toMatchObject({ phase: 'shipped', delivery: secretBuyer.delivery })

    // It did everything that writes: Events of every kind, jobs, logs, sync state.
    const types = new Set((await base.db.eventLog.findMany({ where: { organizationId: org } })).map((event) => event.type))
    for (const type of ['shipment.requested', 'shipment.status_changed', 'shipment.cancel_requested', 'shipment.cancel_refused', 'order.status_changed', 'stock.consumed']) {
      expect(types).toContain(type)
    }
    expect(base.queue.enqueued.slice(enqueuedFrom).map((job) => job.name)).toEqual(expect.arrayContaining(['shipments.create', 'shipments.track', 'orders.updateStatus']))
    expect(logged).toEqual([{ message: 'shipment label given up on', organizationId: org, shipmentId: locker.shipmentId, code: 'too_large', bytes: MAX_LABEL_BYTES + 1 }])
    expect((await getShipmentLabel(ctx, org, locker.shipmentId))).toBeNull()

    const everything = await written()
    for (const secret of SECRETS) expect(everything, secret).not.toContain(secret)
    // Job payloads hold ids only.
    for (const job of base.queue.enqueued.slice(enqueuedFrom).filter((queued) => queued.name.startsWith('shipments.'))) {
      expect(Object.keys(job.payload as object).sort()).toEqual(
        job.name === 'shipments.create' ? ['organizationId', 'shipmentId'] : ['connectionId', 'organizationId'],
      )
    }
    // What the panel lists of a Shipment has nothing sealed in it.
    const listed = JSON.stringify(await listOrderShipments(ctx, org, orderId))
    for (const secret of SECRETS) expect(listed, secret).not.toContain(secret)
  })

  it('an Erasure request clears the Label and the destination of the Order\'s Shipments, and keeps status and tracking number', async () => {
    const { base, ctx, org, carrierId, orderId, create, track } = await setup()
    const admin = await addMember(base, org, 'owner')
    const { shipmentId } = await requestShipment(ctx, org, orderId, lockerShipment(carrierId, { destination: { type: 'pickup_point', pointId: CONFIRMED_POINT } }), user)
    await create(shipmentId)
    const { externalId } = carrier.byReference(shipmentId)!
    carrier.advance(externalId, 'ready')
    await track()
    carrier.advance(externalId, 'in_transit')
    await track()
    const before = await base.db.shipment.findFirstOrThrow({ where: { id: shipmentId } })
    expect(before.label).toMatch(/^v1:/)
    expect(before.destination).toMatch(/^v1:/)
    expect((await getShipmentLabel(ctx, org, shipmentId))?.data).toEqual(LABEL)

    // The pickup shipped the Order, so it is closed and its Buyer data can be erased.
    expect(await eraseBuyerData(ctx, org, 'zofia.sekretna@poczta.example', admin)).toEqual({ erased: 1, keptOpen: 0 })

    const after = await base.db.shipment.findFirstOrThrow({ where: { id: shipmentId } })
    expect(after).toMatchObject({ label: null, labelContentType: null, destination: null, status: 'in_transit', trackingNumber: before.trackingNumber, externalId })
    expect(await getShipmentLabel(ctx, org, shipmentId)).toBeNull()
    expect((await listOrderShipments(ctx, org, orderId))[0]).toMatchObject({ hasLabel: false, status: 'in_transit' })

    // The parcel is still followed, but its Label, which prints the Buyer's address, is not fetched back.
    carrier.calls.label.length = 0
    carrier.advance(externalId, 'awaiting_pickup')
    await track()
    expect(carrier.calls.label).toEqual([])
    expect(await base.db.shipment.findFirstOrThrow({ where: { id: shipmentId } })).toMatchObject({ status: 'awaiting_pickup', label: null })
  })

  it('the Retention period clears them the same way', async () => {
    const { base, ctx, org, carrierId, orderId, create, track } = await setup()
    const admin = await addMember(base, org, 'owner')
    const { shipmentId } = await requestShipment(ctx, org, orderId, lockerShipment(carrierId), user)
    await create(shipmentId)
    const { externalId } = carrier.byReference(shipmentId)!
    carrier.advance(externalId, 'in_transit')
    await track()
    expect((await base.db.shipment.findFirstOrThrow({ where: { id: shipmentId } })).label).not.toBeNull()

    await setBuyerDataRetention(ctx, org, 30, admin)
    const in31Days = new Date(Date.now() + 31 * 86_400_000)
    expect(await applyBuyerDataRetention(ctx, org, in31Days)).toBe(1)

    expect(await base.db.shipment.findFirstOrThrow({ where: { id: shipmentId } })).toMatchObject({ label: null, labelContentType: null, destination: null, status: 'in_transit' })
    expect(await getShipmentLabel(ctx, org, shipmentId)).toBeNull()
  })

  it('a Label that arrives while its Order is being erased is dropped, not written back', async () => {
    const { base, ctx, org, carrierId, orderId, create, track } = await setup()
    const { shipmentId } = await requestShipment(ctx, org, orderId, lockerShipment(carrierId), user)
    await create(shipmentId)
    const { externalId } = carrier.byReference(shipmentId)!
    carrier.advance(externalId, 'in_transit')
    // The track job read the Order before the Erasure; the Erasure commits while the Carrier is serving the Label.
    const serving = carrier.connector.capabilities['shipments.label']!
    carrier.connector.capabilities['shipments.label'] = async (context, input) => {
      await base.db.order.updateMany({ where: { id: orderId }, data: { buyerData: null, buyerEmailIndex: null, buyerDataErasedAt: new Date() } })
      return serving(context, input)
    }
    try {
      await track()
    } finally {
      carrier.connector.capabilities['shipments.label'] = serving
    }
    expect(carrier.calls.label).toEqual([externalId])
    expect(await base.db.shipment.findFirstOrThrow({ where: { id: shipmentId } })).toMatchObject({ status: 'in_transit', label: null, labelContentType: null })
  })
})
