import { TransientError } from '@hanza/connector-sdk'
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
import { listOrderShipments } from './queries'
import { requestShipment } from './request'

const carrier = createTestCarrier({ id: 'cancel-carrier' })
const withoutCancel = createTestCarrier({ id: 'no-cancel-carrier', cancel: false })

describe.skipIf(!databaseUrl)('cancelShipment', () => {
  const context = useTestContext({ connectors: [testChannel, carrier.connector, withoutCancel.connector] })

  beforeEach(() => {
    for (const double of [carrier, withoutCancel]) {
      double.failures = {}
      double.cancelRefusal = null
      double.loseAnswers = 0
      double.duringCreate = null
      double.calls.cancel.length = 0
      double.calls.track.length = 0
    }
    context().queue.waiting.length = 0
  })

  /** A requested Shipment whose create job has not run; `created()` runs it. */
  async function setup(double = carrier) {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const channelId = await createTestConnection(ctx, org)
    const carrierId = await createCarrierConnection(ctx, org, double.connector.id)
    await createProduct(ctx, org, { sku: 'P', name: 'Product', stock: 10 }, user)
    const { orderId } = await importOrder(ctx, org, channelId, buildOrder({ lines: [orderLine('l1', { sku: 'P', quantity: 2 })] }))
    const { shipmentId } = await requestShipment(ctx, org, orderId, lockerShipment(carrierId), user)
    ctx.queue.waiting.length = 0

    const create = () => shipmentsCreateJob.handler(ctx, { organizationId: org, shipmentId }, jobRun)
    const created = async () => {
      await create()
      return double.byReference(shipmentId)!.externalId
    }
    const track = () => shipmentsTrackJob.handler(ctx, { organizationId: org, connectionId: carrierId }, jobRun)
    const cancel = () => cancelShipment(ctx, org, shipmentId, user)
    const shipment = () => ctx.db.shipment.findFirstOrThrow({ where: { id: shipmentId, organizationId: org } })
    const view = async () => (await listOrderShipments(ctx, org, orderId))[0]!
    const events = async () =>
      (await ctx.db.eventLog.findMany({ where: { organizationId: org, type: { startsWith: 'shipment.' } }, orderBy: { id: 'asc' } })).map((event) => [
        event.type,
        event.payload,
      ])
    const trackJob = { name: 'shipments.track', payload: { organizationId: org, connectionId: carrierId }, options: { coalesceKey: `shipments.track:${carrierId}` } }
    return { ctx, org, carrierId, orderId, shipmentId, create, created, track, cancel, shipment, view, events, trackJob }
  }

  it('cancels at once a Shipment the Carrier was never asked for, and its create job then does nothing', async () => {
    const { ctx, shipmentId, create, cancel, shipment, view, events } = await setup()
    expect(await view()).toMatchObject({ status: 'requested', canCancel: true })

    expect(await cancel()).toEqual({ outcome: 'cancelled' })

    expect(await shipment()).toMatchObject({ status: 'cancelled', nextCheckAt: null, cancelRequestedAt: null, externalId: null })
    expect((await events()).at(-1)).toEqual(['shipment.status_changed', { shipmentId, from: 'requested', to: 'cancelled', carrierStatus: null, actor: user }])
    expect(ctx.queue.waiting).toEqual([])
    await create()
    expect(carrier.calls.create.filter((request) => request.reference === shipmentId)).toEqual([])
    expect(carrier.calls.cancel).toEqual([])
    expect(await view()).toMatchObject({ status: 'cancelled', canCancel: false })
    await expect(cancel()).rejects.toMatchObject({ code: 'shipment_not_cancellable' })
  })

  it('cancels locally through a connector without shipments.cancel too', async () => {
    const { cancel, shipment } = await setup(withoutCancel)
    expect(await cancel()).toEqual({ outcome: 'cancelled' })
    expect(await shipment()).toMatchObject({ status: 'cancelled' })
  })

  it('asks the Carrier for a Shipment it knows, and a Carrier that agrees ends it', async () => {
    const { ctx, shipmentId, created, track, cancel, shipment, view, events, trackJob } = await setup()
    const externalId = await created()
    ctx.queue.waiting.length = 0

    expect(await cancel()).toEqual({ outcome: 'requested' })

    // Marked on the row and due at once: the tick finds it if this enqueue is lost.
    const asked = await shipment()
    expect(asked).toMatchObject({ status: 'pending', failureCode: null })
    expect(asked.cancelRequestedAt).not.toBeNull()
    expect(await secondsUntilDue(ctx, shipmentId)).toBeLessThanOrEqual(0)
    expect(ctx.queue.waiting).toEqual([trackJob])
    expect(await view()).toMatchObject({ canCancel: false })
    expect((await events()).at(-1)).toEqual(['shipment.cancel_requested', { shipmentId, actor: user }])
    // Asking twice asks the Carrier once.
    expect(await cancel()).toEqual({ outcome: 'requested' })
    expect((await events()).filter(([type]) => type === 'shipment.cancel_requested')).toHaveLength(1)

    await track()

    expect(carrier.calls.cancel).toEqual([externalId])
    // Cancelled, so there is nothing to track about it.
    expect(carrier.calls.track).toEqual([])
    expect(await shipment()).toMatchObject({ status: 'cancelled', nextCheckAt: null, cancelRequestedAt: null, failureCode: null })
    expect((await events()).at(-1)).toEqual(['shipment.status_changed', { shipmentId, from: 'pending', to: 'cancelled', carrierStatus: null }])
    await track()
    expect(carrier.calls.cancel).toEqual([externalId])
  })

  it('a Carrier that refuses leaves the status, stores its code, and is not asked again', async () => {
    const { shipmentId, created, track, cancel, shipment, view, events } = await setup()
    const externalId = await created()
    carrier.advance(externalId, 'ready')
    carrier.cancelRefusal = 'too_late'
    await cancel()

    await track()

    expect(carrier.calls.cancel).toEqual([externalId])
    // The same run goes on following it.
    expect(carrier.calls.track).toEqual([[externalId]])
    const refused = await shipment()
    expect(refused).toMatchObject({ status: 'ready', failureCode: 'too_late', cancelRequestedAt: null })
    expect(await secondsUntilDue(context(), shipmentId)).toBeGreaterThan(0)
    expect(await view()).toMatchObject({ status: 'ready', failureCode: null, cancelRefusedCode: 'too_late', canCancel: true })
    expect((await events()).map(([type]) => type)).toContain('shipment.cancel_refused')
    expect((await events()).find(([type]) => type === 'shipment.cancel_refused')![1]).toEqual({ shipmentId, code: 'too_late' })

    await track()
    expect(carrier.calls.cancel).toEqual([externalId])

    // Asking again clears the old refusal and puts it to the Carrier once more.
    carrier.cancelRefusal = null
    await cancel()
    expect(await shipment()).toMatchObject({ failureCode: null })
    await track()
    expect(await shipment()).toMatchObject({ status: 'cancelled' })
  })

  it('refuses when the Carrier would have to be asked and its connector cannot', async () => {
    const { created, cancel, shipment, view, events } = await setup(withoutCancel)
    await created()
    expect(await view()).toMatchObject({ status: 'pending', canCancel: false })
    await expect(cancel()).rejects.toMatchObject({ name: 'DomainError', code: 'shipment_cancel_unsupported' })
    expect(await shipment()).toMatchObject({ status: 'pending', cancelRequestedAt: null })
    expect((await events()).map(([type]) => type)).toEqual(['shipment.requested', 'shipment.status_changed'])
  })

  it('refuses once the Carrier has the parcel, or the Shipment is final', async () => {
    const { ctx, shipmentId, created, track, cancel, view } = await setup()
    const externalId = await created()
    carrier.advance(externalId, 'in_transit')
    await ctx.db.$executeRaw`UPDATE "shipment" SET "nextCheckAt" = now() - interval '1 second' WHERE "id" = ${shipmentId}`
    await track()
    expect(await view()).toMatchObject({ status: 'in_transit', canCancel: false })
    await expect(cancel()).rejects.toMatchObject({ code: 'shipment_not_cancellable' })
    expect(carrier.calls.cancel).toEqual([])
  })

  it('refuses another organization\'s Shipment, and one that does not exist', async () => {
    const { ctx, shipmentId, shipment } = await setup()
    const other = await createTestOrganization(ctx.db)
    await expect(cancelShipment(ctx, other, shipmentId, user)).rejects.toMatchObject({ code: 'not_found' })
    await expect(cancelShipment(ctx, other, 'no-such-shipment', user)).rejects.toMatchObject({ code: 'not_found' })
    expect(await shipment()).toMatchObject({ status: 'requested' })
  })

  describe('while the Carrier is being asked to create it', () => {
    /** Holds the create call open inside the Carrier until `answer()`. */
    function holdCreate() {
      let arrived!: () => void
      const inFlight = new Promise<void>((resolve) => (arrived = resolve))
      let answer!: () => void
      carrier.duringCreate = () => {
        arrived()
        return new Promise<void>((resolve) => (answer = resolve))
      }
      return { inFlight, answer: () => answer() }
    }

    it('is not cancelled locally; the create hands it on and the Carrier is asked to cancel what it made', async () => {
      const { ctx, shipmentId, create, track, cancel, shipment, events, trackJob } = await setup()
      const held = holdCreate()
      const creating = create()
      await held.inFlight

      expect(await cancel()).toEqual({ outcome: 'requested' })
      expect(await shipment()).toMatchObject({ status: 'requested', externalId: null })
      expect((await shipment()).cancelRequestedAt).not.toBeNull()

      held.answer()
      await creating
      const externalId = carrier.byReference(shipmentId)!.externalId
      const made = await shipment()
      expect(made).toMatchObject({ status: 'pending', externalId })
      expect(made.cancelRequestedAt).not.toBeNull()
      expect(ctx.queue.waiting).toContainEqual(trackJob)

      await ctx.db.$executeRaw`UPDATE "shipment" SET "nextCheckAt" = now() - interval '1 second' WHERE "id" = ${shipmentId}`
      await track()
      expect(carrier.calls.cancel).toEqual([externalId])
      expect(await shipment()).toMatchObject({ status: 'cancelled' })
      expect((await events()).map(([type]) => type)).toEqual([
        'shipment.requested',
        'shipment.cancel_requested',
        'shipment.status_changed',
        'shipment.status_changed',
      ])
    })

    it('and that create fails: the next run cancels it instead of asking again, and says an attempt was made', async () => {
      const { shipmentId, create, cancel, shipment, events } = await setup()
      const held = holdCreate()
      const creating = create()
      await held.inFlight
      await cancel()
      // The Carrier makes the Shipment, and its answer never arrives.
      carrier.loseAnswers = 1
      held.answer()
      await expect(creating).rejects.toBeInstanceOf(TransientError)
      expect(await shipment()).toMatchObject({ status: 'requested', createAttempts: 1, createLeaseUntil: null })

      carrier.duringCreate = null
      const asked = carrier.calls.create.length
      await create()

      expect(carrier.calls.create).toHaveLength(asked)
      expect(await shipment()).toMatchObject({ status: 'cancelled', nextCheckAt: null, cancelRequestedAt: null })
      // The Carrier may hold a Shipment whose answer was lost: the trail says so, for a person to check there.
      expect((await events()).at(-1)).toEqual([
        'shipment.status_changed',
        { shipmentId, from: 'requested', to: 'cancelled', carrierStatus: null, actor: { type: 'system' }, createAttempted: true },
      ])
    })
  })

  it('a Shipment whose create lost its answer is cancelled locally, with the attempt on record', async () => {
    const { create, cancel, shipment, events } = await setup()
    carrier.loseAnswers = 1
    await expect(create()).rejects.toBeInstanceOf(TransientError)

    expect(await cancel()).toEqual({ outcome: 'cancelled' })

    expect(await shipment()).toMatchObject({ status: 'cancelled', externalId: null, createAttempts: 1 })
    expect((await events()).at(-1)![1]).toMatchObject({ to: 'cancelled', actor: user, createAttempted: true })
  })
})
