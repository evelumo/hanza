import { beforeEach, describe, expect, it } from 'vitest'
import { createProduct } from '../catalog/products'
import { shipmentsCreateJob } from '../jobs/shipments-create'
import { shipmentsTrackJob } from '../jobs/shipments-track'
import { importOrder } from '../orders/import'
import { createTestCarrier } from '../testing/carrier'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, createCarrierConnection, createTestConnection, jobRun, lockerShipment, orderLine, secondsUntilDue, testChannel, user } from '../testing/fixtures'
import { cancelShipment } from './cancel'
import { requestShipmentCheck } from './check'
import { requestShipment } from './request'
import { SHIPMENT_FOLLOW_MS } from './schedule'

const carrier = createTestCarrier({ id: 'check-carrier' })

describe.skipIf(!databaseUrl)('requestShipmentCheck', () => {
  const context = useTestContext({ connectors: [testChannel, carrier.connector] })

  beforeEach(() => {
    carrier.calls.track.length = 0
    context().queue.waiting.length = 0
  })

  /** A requested Shipment whose create job has not run; `confirmed()` runs it and one check, after which the Carrier says `ready`. */
  async function setup() {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const channelId = await createTestConnection(ctx, org)
    const carrierId = await createCarrierConnection(ctx, org, carrier.connector.id)
    await createProduct(ctx, org, { sku: 'P', name: 'Product', stock: 10 }, user)
    const { orderId } = await importOrder(ctx, org, channelId, buildOrder({ lines: [orderLine('l1', { sku: 'P', quantity: 2 })] }))
    const { shipmentId } = await requestShipment(ctx, org, orderId, lockerShipment(carrierId), user)
    ctx.queue.waiting.length = 0

    const track = () => shipmentsTrackJob.handler(ctx, { organizationId: org, connectionId: carrierId }, jobRun)
    const confirmed = async () => {
      await shipmentsCreateJob.handler(ctx, { organizationId: org, shipmentId }, jobRun)
      // The delayed first check of a new Shipment: not what these tests are about.
      ctx.queue.waiting.length = 0
      const { externalId } = carrier.byReference(shipmentId)!
      carrier.advance(externalId, 'ready')
      await ctx.db.$executeRaw`UPDATE "shipment" SET "nextCheckAt" = now() WHERE "id" = ${shipmentId}`
      await track()
      carrier.calls.track.length = 0
      return externalId
    }
    const shipment = () => ctx.db.shipment.findFirstOrThrow({ where: { id: shipmentId, organizationId: org } })
    const trackJob = { name: 'shipments.track', payload: { organizationId: org, connectionId: carrierId }, options: { coalesceKey: `shipments.track:${carrierId}` } }
    return { ctx, org, orderId, shipmentId, track, confirmed, shipment, trackJob }
  }

  it('makes a confirmed Shipment due at once and asks its Carrier through the Connection’s track job', async () => {
    const { ctx, org, orderId, shipmentId, track, confirmed, shipment, trackJob } = await setup()
    const externalId = await confirmed()
    // Confirmed a moment ago: on its own it would be asked again in 15 minutes, and a run now finds nothing due.
    expect(await secondsUntilDue(ctx, shipmentId)).toBeGreaterThan(60)
    await track()
    expect(carrier.calls.track).toEqual([])
    const events = () => ctx.db.eventLog.count({ where: { organizationId: org } })
    const before = { shipment: await shipment(), events: await events() }

    await requestShipmentCheck(ctx, org, shipmentId)

    expect(await secondsUntilDue(ctx, shipmentId)).toBeLessThanOrEqual(0)
    expect(ctx.queue.waiting).toEqual([trackJob])
    // Asking is not a change of the Shipment: no Event, and nothing but its due time moved.
    expect(await shipment()).toMatchObject({ status: 'ready', updatedAt: before.shipment.updatedAt })
    expect(await events()).toBe(before.events)

    // The Carrier took the parcel in the meantime: the check sees it now, and the Order is shipped (ADR 0024).
    carrier.advance(externalId, 'in_transit')
    await track()
    expect(carrier.calls.track).toEqual([[externalId]])
    expect(await shipment()).toMatchObject({ status: 'in_transit' })
    expect(await ctx.db.order.findFirstOrThrow({ where: { id: orderId, organizationId: org } })).toMatchObject({ phase: 'shipped' })
    // The job wrote the real next check: an hour ahead once the Carrier has the parcel.
    expect(await secondsUntilDue(ctx, shipmentId)).toBeGreaterThan(60)
  })

  it('never moves a due time later, and checks a Shipment that is no longer followed once', async () => {
    const { ctx, org, shipmentId, track, confirmed, trackJob } = await setup()
    const externalId = await confirmed()

    await ctx.db.$executeRaw`UPDATE "shipment" SET "nextCheckAt" = now() - interval '5 minutes' WHERE "id" = ${shipmentId}`
    await requestShipmentCheck(ctx, org, shipmentId)
    expect(await secondsUntilDue(ctx, shipmentId)).toBeLessThan(-200)

    // Sixty days after it was requested nothing is owed to it any more; a person may still ask.
    await ctx.db.$executeRaw`
      UPDATE "shipment" SET "nextCheckAt" = NULL, "createdAt" = now() - ${SHIPMENT_FOLLOW_MS + 60_000}::bigint * interval '1 millisecond'
      WHERE "id" = ${shipmentId}`
    ctx.queue.waiting.length = 0
    await requestShipmentCheck(ctx, org, shipmentId)
    expect(await secondsUntilDue(ctx, shipmentId)).toBeLessThanOrEqual(0)
    expect(ctx.queue.waiting).toEqual([trackJob])
    await track()
    expect(carrier.calls.track).toEqual([[externalId]])
    expect(await secondsUntilDue(ctx, shipmentId)).toBeNull()
  })

  it('refuses a Shipment the Carrier does not know yet', async () => {
    const { ctx, org, shipmentId, shipment } = await setup()
    const before = await shipment()

    await expect(requestShipmentCheck(ctx, org, shipmentId)).rejects.toMatchObject({ name: 'DomainError', code: 'shipment_not_checkable' })

    expect(await shipment()).toMatchObject({ status: 'requested', externalId: null, nextCheckAt: before.nextCheckAt })
    expect(ctx.queue.waiting).toEqual([])
  })

  it('refuses a Shipment that is final', async () => {
    const { ctx, org, shipmentId, track, confirmed, shipment } = await setup()
    await confirmed()
    await cancelShipment(ctx, org, shipmentId, user)
    await track()
    expect(await shipment()).toMatchObject({ status: 'cancelled', nextCheckAt: null })
    ctx.queue.waiting.length = 0

    await expect(requestShipmentCheck(ctx, org, shipmentId)).rejects.toMatchObject({ name: 'DomainError', code: 'shipment_not_checkable' })

    expect(await shipment()).toMatchObject({ nextCheckAt: null })
    expect(ctx.queue.waiting).toEqual([])
  })

  it('does not find another organization’s Shipment', async () => {
    const { ctx, shipmentId, confirmed } = await setup()
    await confirmed()
    const other = await createTestOrganization(ctx.db)
    ctx.queue.waiting.length = 0

    await expect(requestShipmentCheck(ctx, other, shipmentId)).rejects.toMatchObject({ name: 'DomainError', code: 'not_found' })

    expect(await secondsUntilDue(ctx, shipmentId)).toBeGreaterThan(60)
    expect(ctx.queue.waiting).toEqual([])
  })

  it('succeeds when the enqueue is lost: the Shipment is due, so the tick asks', async () => {
    const { ctx, org, shipmentId, confirmed } = await setup()
    await confirmed()
    const queueDown = {
      ...ctx,
      queue: {
        ...ctx.queue,
        enqueue: async () => {
          throw new Error('Redis unavailable')
        },
      },
    }

    await requestShipmentCheck(queueDown, org, shipmentId)

    expect(await secondsUntilDue(ctx, shipmentId)).toBeLessThanOrEqual(0)
  })
})
