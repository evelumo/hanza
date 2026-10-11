import { randomUUID } from 'node:crypto'
import { AuthExpiredError, PermanentError, RateLimitedError, SHIPMENT_STATUSES, TransientError, isFinalShipmentStatus, type ShipmentStatus } from '@hanza/connector-sdk'
import { beforeEach, describe, expect, it } from 'vitest'
import { createProduct } from '../catalog/products'
import { PermanentJobError, RetryLaterError } from '../jobs'
import { importOrder } from '../orders/import'
import { cancelShipment } from '../shipments/cancel'
import { getShipmentLabel } from '../shipments/label'
import { listOrderShipments } from '../shipments/queries'
import { requestShipment } from '../shipments/request'
import { MAX_LABEL_BYTES } from '../shipments/sealed'
import { createTestCarrier } from '../testing/carrier'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, createCarrierConnection, createTestConnection, jobRun, lockerShipment, orderLine, secondsUntilDue, testChannel, user } from '../testing/fixtures'
import { shipmentsCreateJob } from './shipments-create'
import { shipmentsTrackJob } from './shipments-track'

const carrier = createTestCarrier({ id: 'track-carrier' })

describe.skipIf(!databaseUrl)('shipments.track', () => {
  const context = useTestContext({ connectors: [testChannel, carrier.connector] })

  beforeEach(() => {
    carrier.failures = {}
    carrier.silent.clear()
    carrier.unasked = []
    carrier.label = { contentType: 'application/pdf', data: new TextEncoder().encode('%PDF-1.7 label of a test parcel') }
    carrier.calls.track.length = 0
    carrier.calls.label.length = 0
    carrier.calls.cancel.length = 0
    carrier.cancelRefusal = null
    carrier.duringTrack = null
    carrier.cancelFailures.clear()
    carrier.labelFailures.clear()
    carrier.labels.clear()
  })

  /** How many of the organization's Shipments are due now, on the database's clock. */
  async function overdue(organizationId: string): Promise<number> {
    const rows = await context().db.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS "count" FROM "shipment" WHERE "organizationId" = ${organizationId} AND "nextCheckAt" <= now()`
    return rows[0]!.count
  }

  /** An organization with a Carrier Connection and an Order; `created()` adds a Shipment the Carrier has confirmed nothing about. */
  async function setup() {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const channelId = await createTestConnection(ctx, org)
    const carrierId = await createCarrierConnection(ctx, org, 'track-carrier')
    await createProduct(ctx, org, { sku: 'P', name: 'Product', stock: 10 }, user)
    const { orderId } = await importOrder(ctx, org, channelId, buildOrder({ lines: [orderLine('l1', { sku: 'P', quantity: 2 })] }))
    // The queue is shared by the tests of this file: what an earlier one left waiting is not this one's.
    ctx.queue.waiting.length = 0

    const due = (shipmentId: string) => ctx.db.$executeRaw`UPDATE "shipment" SET "nextCheckAt" = now() - interval '1 second' WHERE "id" = ${shipmentId}`
    const created = async () => {
      const { shipmentId } = await requestShipment(ctx, org, orderId, lockerShipment(carrierId), user)
      await shipmentsCreateJob.handler(ctx, { organizationId: org, shipmentId }, jobRun)
      await due(shipmentId)
      ctx.queue.waiting.length = 0
      return { shipmentId, externalId: carrier.byReference(shipmentId)!.externalId }
    }
    const track = (run = jobRun) => shipmentsTrackJob.handler(ctx, { organizationId: org, connectionId: carrierId }, run)
    const shipment = (shipmentId: string) => ctx.db.shipment.findFirstOrThrow({ where: { id: shipmentId, organizationId: org } })
    const events = async (shipmentId: string) =>
      (await ctx.db.eventLog.findMany({ where: { organizationId: org, type: { startsWith: 'shipment.' } }, orderBy: { id: 'asc' } }))
        .filter((event) => (event.payload as { shipmentId?: string }).shipmentId === shipmentId)
        .map((event) => [event.type, event.payload])
    const connection = async () => ({
      health: (await ctx.db.connection.findFirstOrThrow({ where: { id: carrierId } })).health,
      sync: await ctx.db.syncState.findFirst({ where: { connectionId: carrierId, stream: 'shipments_track' } }),
    })
    /** Minutes until the Shipment is due again, on the database's clock; null when nothing is owed to it. */
    const dueIn = async (shipmentId: string) => {
      const seconds = await secondsUntilDue(ctx, shipmentId)
      return seconds === null ? null : seconds / 60
    }
    const view = async (shipmentId: string) => (await listOrderShipments(ctx, org, orderId)).find((row) => row.id === shipmentId)!
    const order = () => ctx.db.order.findFirstOrThrow({ where: { id: orderId, organizationId: org } })
    const trackJob = { name: 'shipments.track', payload: { organizationId: org, connectionId: carrierId }, options: { coalesceKey: `shipments.track:${carrierId}` } }
    return { ctx, org, carrierId, orderId, created, due, track, shipment, events, connection, dueIn, view, order, trackJob }
  }

  describe('applies what the Carrier says', () => {
    it.each(SHIPMENT_STATUSES.filter((status) => status !== 'pending'))('%s', async (status: ShipmentStatus) => {
      const { created, track, shipment, events, dueIn } = await setup()
      const { shipmentId, externalId } = await created()
      carrier.advance(externalId, status, `carrier_${status}`)

      await track()

      const stored = await shipment(shipmentId)
      expect(stored).toMatchObject({ status, carrierStatus: `carrier_${status}`, trackingNumber: `TRACK-${externalId}` })
      const final = isFinalShipmentStatus(status)
      expect((await dueIn(shipmentId)) === null).toBe(final)
      expect(stored.failureCode).toBe(status === 'failed' ? 'carrier_failed' : null)
      const handedOver = ['in_transit', 'awaiting_pickup', 'delivery_problem', 'delivered', 'returned'].includes(status)
      expect(stored.handedOverAt !== null).toBe(handedOver)
      expect((await events(shipmentId)).at(-1)).toEqual(
        status === 'failed'
          ? ['shipment.failed', { shipmentId, from: 'pending', code: 'carrier_failed' }]
          : ['shipment.status_changed', { shipmentId, from: 'pending', to: status, carrierStatus: `carrier_${status}` }],
      )
    })

    it('pending: nothing changed, so no Event, only the next check', async () => {
      const { created, track, shipment, events, connection, dueIn } = await setup()
      const { shipmentId, externalId } = await created()
      const before = await events(shipmentId)

      await track()

      expect(carrier.calls.track).toEqual([[externalId]])
      expect(await shipment(shipmentId)).toMatchObject({ status: 'pending', trackingNumber: null })
      expect(await dueIn(shipmentId)).toBeGreaterThan(0)
      expect(await events(shipmentId)).toEqual(before)
      expect(await connection()).toMatchObject({ health: 'ok', sync: { lastResult: { checked: 1, changed: 0, labels: 0, cancelled: 0 } } })
    })
  })

  it('follows a Shipment through its statuses, keeps a tracking number the Carrier stops repeating, and never leaves a final status', async () => {
    const { created, due, track, shipment, events } = await setup()
    const { shipmentId, externalId } = await created()
    for (const status of ['ready', 'in_transit', 'awaiting_pickup', 'delivered'] as const) {
      carrier.advance(externalId, status)
      if (status === 'awaiting_pickup') carrier.shipments.get(externalId)!.trackingNumber = null
      await due(shipmentId)
      await track()
      expect(await shipment(shipmentId)).toMatchObject({ status, trackingNumber: `TRACK-${externalId}` })
    }
    expect((await events(shipmentId)).map(([type, payload]) => [type, (payload as { to?: string }).to])).toEqual([
      ['shipment.requested', undefined],
      ['shipment.status_changed', 'pending'],
      ['shipment.status_changed', 'ready'],
      ['shipment.status_changed', 'in_transit'],
      ['shipment.status_changed', 'awaiting_pickup'],
      ['shipment.status_changed', 'delivered'],
    ])

    // A Carrier that changes its mind about a delivered parcel is not followed: it is not even asked.
    carrier.advance(externalId, 'in_transit')
    carrier.calls.track.length = 0
    await track()
    expect(carrier.calls.track).toEqual([])
    expect(await shipment(shipmentId)).toMatchObject({ status: 'delivered', nextCheckAt: null })
  })

  it('checks only due Shipments, and ignores a state for a Shipment it did not ask about', async () => {
    const { created, due, track, shipment } = await setup()
    const asked = await created()
    const notDue = await created()
    await context().db.$executeRaw`UPDATE "shipment" SET "nextCheckAt" = now() + interval '5 minutes' WHERE "id" = ${notDue.shipmentId}`
    // The connector answers for a Shipment that was not in the call, and for one that is nobody's.
    carrier.unasked = [
      { externalId: notDue.externalId, status: 'delivered', trackingNumber: 'FORGED', carrierStatus: null },
      { externalId: 'someone-elses', status: 'delivered', trackingNumber: null, carrierStatus: null },
    ]
    carrier.advance(asked.externalId, 'ready')

    await track()

    expect(carrier.calls.track).toEqual([[asked.externalId]])
    expect(await shipment(asked.shipmentId)).toMatchObject({ status: 'ready' })
    expect(await shipment(notDue.shipmentId)).toMatchObject({ status: 'pending', trackingNumber: null })

    // Once it is due, its own state is applied.
    carrier.unasked = []
    await due(notDue.shipmentId)
    await track()
    expect(await shipment(notDue.shipmentId)).toMatchObject({ status: 'pending' })
  })

  it('a Shipment the Carrier leaves out of its answer is unchanged, and checked again later', async () => {
    const { created, track, shipment, dueIn } = await setup()
    const { shipmentId, externalId } = await created()
    carrier.advance(externalId, 'ready')
    carrier.silent.add(externalId)
    await track()
    expect(await shipment(shipmentId)).toMatchObject({ status: 'pending', trackingNumber: null })
    expect(await dueIn(shipmentId)).toBeGreaterThan(0)
  })

  it('asks about at most 100 Shipments per call: 230 due ones take three', async () => {
    const { ctx, org, carrierId, orderId, track, connection } = await setup()
    const rows = Array.from({ length: 230 }, (_, index) => ({
      id: randomUUID(),
      organizationId: org,
      orderId,
      connectionId: carrierId,
      status: 'ready' as const,
      service: 'test_locker',
      parcel: { preset: 'small' },
      externalId: `bulk-${org}-${index}`,
      labelContentType: 'application/pdf',
      label: 'v1:not:a:label',
      nextCheckAt: new Date(Date.now() - 60_000 - index),
    }))
    await ctx.db.shipment.createMany({ data: rows })
    for (const row of rows) {
      carrier.shipments.set(row.externalId, { externalId: row.externalId, reference: row.id, status: 'in_transit', trackingNumber: null, carrierStatus: null })
    }

    await track()

    expect(carrier.calls.track.map((ids) => ids.length)).toEqual([100, 100, 30])
    expect(new Set(carrier.calls.track.flat()).size).toBe(230)
    expect(await ctx.db.shipment.count({ where: { organizationId: org, status: 'in_transit' } })).toBe(230)
    expect(await overdue(org)).toBe(0)
    expect(await connection()).toMatchObject({ sync: { lastResult: { checked: 230, changed: 230 } } })
    for (const row of rows) carrier.shipments.delete(row.externalId)
  })

  it('a backlog larger than one run takes is left to a run after it', async () => {
    const { ctx, org, carrierId, orderId, track } = await setup()
    const rows = Array.from({ length: 501 }, (_, index) => ({
      id: randomUUID(),
      organizationId: org,
      orderId,
      connectionId: carrierId,
      status: 'in_transit' as const,
      service: 'test_locker',
      parcel: { preset: 'small' },
      externalId: `backlog-${org}-${index}`,
      handedOverAt: new Date(),
      labelContentType: 'application/pdf',
      label: 'v1:not:a:label',
      nextCheckAt: new Date(Date.now() - 60_000),
    }))
    await ctx.db.shipment.createMany({ data: rows })

    await track()

    expect(carrier.calls.track.map((ids) => ids.length)).toEqual([100, 100, 100, 100, 100])
    expect(await overdue(org)).toBe(1)
    expect(ctx.queue.waiting).toEqual([
      { name: 'shipments.track', payload: { organizationId: org, connectionId: carrierId }, options: { coalesceKey: `shipments.track:${carrierId}` } },
    ])
    ctx.queue.waiting.length = 0
  })

  describe('the next check', () => {
    it('is the next tick for a fresh unconfirmed Shipment, then 10 minutes; 15 minutes when ready; an hour once the Carrier has it', async () => {
      const { ctx, created, due, track, dueIn } = await setup()
      const { shipmentId, externalId } = await created()
      await track()
      expect(await dueIn(shipmentId)).toBeGreaterThan(0.4)
      expect(await dueIn(shipmentId)).toBeLessThanOrEqual(0.5)

      await ctx.db.$executeRaw`UPDATE "shipment" SET "createdAt" = now() - interval '11 minutes' WHERE "id" = ${shipmentId}`
      await due(shipmentId)
      await track()
      expect(await dueIn(shipmentId)).toBeGreaterThan(9.9)
      expect(await dueIn(shipmentId)).toBeLessThanOrEqual(10)

      carrier.advance(externalId, 'ready')
      await due(shipmentId)
      await track()
      expect(await dueIn(shipmentId)).toBeGreaterThan(14.9)
      expect(await dueIn(shipmentId)).toBeLessThanOrEqual(15)

      carrier.advance(externalId, 'in_transit')
      await due(shipmentId)
      await track()
      expect(await dueIn(shipmentId)).toBeGreaterThan(59.9)
      expect(await dueIn(shipmentId)).toBeLessThanOrEqual(60)
    })

    it('ends 60 days after the Shipment was requested: it keeps its status and is not asked about again', async () => {
      const { ctx, created, track, shipment } = await setup()
      const { shipmentId, externalId } = await created()
      carrier.advance(externalId, 'in_transit')
      await ctx.db.$executeRaw`UPDATE "shipment" SET "createdAt" = now() - interval '60 days 1 hour' WHERE "id" = ${shipmentId}`
      await track()
      expect(await shipment(shipmentId)).toMatchObject({ status: 'in_transit', nextCheckAt: null })
      carrier.calls.track.length = 0
      await track()
      expect(carrier.calls.track).toEqual([])
    })
  })

  describe('a confirmed Shipment whose Label is not there yet', () => {
    it('is checked again at the next tick, because a person is waiting to print it, and at the usual interval once it has the Label', async () => {
      const { created, due, track, shipment, dueIn } = await setup()
      const { shipmentId, externalId } = await created()
      carrier.advance(externalId, 'ready')
      carrier.failures.label = new TransientError('invalid_action: no label yet')

      await track()

      expect(await shipment(shipmentId)).toMatchObject({ status: 'ready', label: null, labelFailureCode: null })
      expect(await dueIn(shipmentId)).toBeGreaterThan(0.4)
      expect(await dueIn(shipmentId)).toBeLessThanOrEqual(0.5)

      carrier.failures = {}
      await due(shipmentId)
      await track()
      expect((await shipment(shipmentId)).label).toMatch(/^v1:/)
      expect(await dueIn(shipmentId)).toBeGreaterThan(14.9)
      expect(await dueIn(shipmentId)).toBeLessThanOrEqual(15)
    })

    it('is checked at the usual interval once an hour has passed since it was requested: a Carrier that never has one is not asked every minute', async () => {
      const { ctx, created, track, dueIn } = await setup()
      const { shipmentId, externalId } = await created()
      carrier.advance(externalId, 'ready')
      carrier.failures.label = new TransientError('invalid_action: no label yet')
      await ctx.db.$executeRaw`UPDATE "shipment" SET "createdAt" = now() - interval '61 minutes' WHERE "id" = ${shipmentId}`
      await track()
      expect(await dueIn(shipmentId)).toBeGreaterThan(14.9)
      expect(await dueIn(shipmentId)).toBeLessThanOrEqual(15)
    })

    it('is not hurried for an Order whose Buyer data is erased, since no Label is fetched for it', async () => {
      const { ctx, orderId, created, track, dueIn } = await setup()
      const { shipmentId, externalId } = await created()
      carrier.advance(externalId, 'ready')
      await ctx.db.order.updateMany({ where: { id: orderId }, data: { buyerData: null, buyerEmailIndex: null, buyerDataErasedAt: new Date() } })
      await track()
      expect(carrier.calls.label).toEqual([])
      expect(await dueIn(shipmentId)).toBeGreaterThan(14.9)
    })
  })

  describe('a status that goes backwards', () => {
    it('a late pending cannot fail a Shipment the Carrier has, however old it is', async () => {
      const { ctx, created, due, track, shipment, events, order, dueIn } = await setup()
      const { shipmentId, externalId } = await created()
      carrier.advance(externalId, 'in_transit', 'collected')
      await track()
      expect(await order()).toMatchObject({ phase: 'shipped' })
      const taken = await shipment(shipmentId)
      const before = await events(shipmentId)

      // More than 24 hours after it was requested the Carrier's list says pending once (it lags, or the connector mistranslates).
      await ctx.db.$executeRaw`UPDATE "shipment" SET "createdAt" = now() - interval '25 hours' WHERE "id" = ${shipmentId}`
      carrier.advance(externalId, 'pending', 'created')
      await due(shipmentId)
      await track()

      const kept = await shipment(shipmentId)
      expect(kept).toMatchObject({ status: 'in_transit', carrierStatus: 'collected', failureCode: null, handedOverAt: taken.handedOverAt, trackingNumber: taken.trackingNumber })
      expect(kept.label).toBe(taken.label)
      // Still followed, at the interval of its real status.
      expect(await dueIn(shipmentId)).toBeGreaterThan(59.9)
      expect(await events(shipmentId)).toEqual(before)
      expect(await order()).toMatchObject({ phase: 'shipped' })

      // And it goes on from where it was.
      carrier.advance(externalId, 'delivered', 'delivered')
      await due(shipmentId)
      await track()
      expect(await shipment(shipmentId)).toMatchObject({ status: 'delivered', failureCode: null })
    })

    it('never takes a confirmed Shipment back to pending, where the timeout would fail it, nor one the Carrier has back to ready', async () => {
      const { ctx, created, due, track, shipment, events } = await setup()
      const confirmed = await created()
      const taken = await created()
      carrier.advance(confirmed.externalId, 'ready', 'confirmed')
      carrier.advance(taken.externalId, 'awaiting_pickup', 'ready_to_pickup')
      await track()
      const labelled = await shipment(confirmed.shipmentId)
      expect(labelled.label).toMatch(/^v1:/)

      await ctx.db.$executeRaw`UPDATE "shipment" SET "createdAt" = now() - interval '25 hours' WHERE "id" IN (${confirmed.shipmentId}, ${taken.shipmentId})`
      carrier.advance(confirmed.externalId, 'pending', 'offers_prepared')
      carrier.advance(taken.externalId, 'ready', 'confirmed')
      for (let round = 0; round < 2; round++) {
        await due(confirmed.shipmentId)
        await due(taken.shipmentId)
        await track()
      }

      expect(await shipment(confirmed.shipmentId)).toMatchObject({ status: 'ready', carrierStatus: 'confirmed', failureCode: null, label: labelled.label })
      expect(await shipment(taken.shipmentId)).toMatchObject({ status: 'awaiting_pickup', carrierStatus: 'ready_to_pickup', failureCode: null })
      expect((await shipment(taken.shipmentId)).handedOverAt).not.toBeNull()
      expect((await events(confirmed.shipmentId)).map(([type]) => type)).toEqual(['shipment.requested', 'shipment.status_changed', 'shipment.status_changed'])

      // Within what the Carrier has, a status moves either way.
      carrier.advance(taken.externalId, 'in_transit', 'redirected')
      await due(taken.shipmentId)
      await track()
      expect(await shipment(taken.shipmentId)).toMatchObject({ status: 'in_transit', carrierStatus: 'redirected' })
    })
  })

  describe('the Carrier\'s own status of a Shipment it has not confirmed', () => {
    it('is stored and shown, and a change of it alone is one Event, not one for every poll', async () => {
      const { created, due, track, shipment, events, view } = await setup()
      const { shipmentId, externalId } = await created()
      const poll = async () => {
        await due(shipmentId)
        await track()
      }
      // The purchase failed for a reason the seller can mend: still pending, and only this code says what it waits for.
      carrier.advance(externalId, 'pending', 'debt_collection')
      await poll()

      expect(await shipment(shipmentId)).toMatchObject({ status: 'pending', carrierStatus: 'debt_collection', failureCode: null })
      expect(await view(shipmentId)).toMatchObject({ status: 'pending', carrierStatus: 'debt_collection' })
      expect((await events(shipmentId)).at(-1)).toEqual(['shipment.carrier_status_changed', { shipmentId, status: 'pending', from: null, to: 'debt_collection' }])
      const once = (await events(shipmentId)).length

      await poll()
      await poll()
      expect(await events(shipmentId)).toHaveLength(once)

      carrier.advance(externalId, 'pending', 'offers_prepared')
      await poll()
      expect((await events(shipmentId)).at(-1)).toEqual(['shipment.carrier_status_changed', { shipmentId, status: 'pending', from: 'debt_collection', to: 'offers_prepared' }])
      expect(await events(shipmentId)).toHaveLength(once + 1)

      // A Carrier status that goes away is stored, without an Event of its own.
      carrier.advance(externalId, 'pending', null)
      await poll()
      expect(await shipment(shipmentId)).toMatchObject({ status: 'pending', carrierStatus: null })
      expect(await events(shipmentId)).toHaveLength(once + 1)
    })

    it('is tracking detail once the Carrier has the parcel: stored, with an Event only when the Shipment status changes', async () => {
      const { created, due, track, shipment, events } = await setup()
      const { shipmentId, externalId } = await created()
      carrier.advance(externalId, 'in_transit', 'collected_from_sender')
      await track()
      const moved = (await events(shipmentId)).length
      for (const carrierStatus of ['adopted_at_source_branch', 'sent_from_source_branch', 'out_for_delivery']) {
        carrier.advance(externalId, 'in_transit', carrierStatus)
        await due(shipmentId)
        await track()
        expect(await shipment(shipmentId)).toMatchObject({ status: 'in_transit', carrierStatus })
      }
      expect(await events(shipmentId)).toHaveLength(moved)
    })
  })

  describe('a cancel a person asked for', () => {
    it('that comes in while its batch is being tracked goes out with a run right after, not an interval later', async () => {
      const { ctx, org, created, track, shipment, dueIn, trackJob } = await setup()
      const { shipmentId, externalId } = await created()
      // The job has read the batch and is asking the Carrier; the person presses "Cancel shipment" now.
      carrier.duringTrack = async () => {
        carrier.duringTrack = null
        expect(await cancelShipment(ctx, org, shipmentId, user)).toEqual({ outcome: 'requested' })
        // Its own enqueue is lost with the queue: the job must not rely on it.
        ctx.queue.waiting.length = 0
      }

      await track()

      expect(carrier.calls.cancel).toEqual([])
      expect((await shipment(shipmentId)).cancelRequestedAt).not.toBeNull()
      // Still due at once: the status the job applied did not put it off.
      expect(await dueIn(shipmentId)).toBeLessThanOrEqual(0)
      expect(ctx.queue.waiting).toEqual([trackJob])
      ctx.queue.waiting.length = 0

      await track()
      expect(carrier.calls.cancel).toEqual([externalId])
      expect(await shipment(shipmentId)).toMatchObject({ status: 'cancelled', cancelRequestedAt: null })
    })

    it('that the Carrier\'s API refuses for good does not stop the batch: the other Shipment\'s pickup still ships the Order, round after round', async () => {
      const { ctx, org, created, due, track, shipment, events, connection, dueIn, order } = await setup()
      const stuck = await created()
      const taken = await created()
      await cancelShipment(ctx, org, stuck.shipmentId, user)
      ctx.queue.waiting.length = 0
      carrier.cancelFailures.set(stuck.externalId, new PermanentError('400 invalid_action'))
      carrier.advance(taken.externalId, 'in_transit', 'collected')

      await expect(track()).rejects.toBeInstanceOf(PermanentJobError)

      // The failure is on the Connection, and the batch was tracked all the same, the failed one included.
      expect(await connection()).toMatchObject({ health: 'failing', sync: { lastErrorKind: 'permanent' } })
      expect(carrier.calls.cancel).toEqual([stuck.externalId])
      expect(carrier.calls.track).toEqual([[stuck.externalId, taken.externalId]])
      expect(await shipment(taken.shipmentId)).toMatchObject({ status: 'in_transit', carrierStatus: 'collected' })
      expect((await shipment(taken.shipmentId)).handedOverAt).not.toBeNull()
      expect(await order()).toMatchObject({ phase: 'shipped' })
      // Each has a next time of its own: the one whose cancel failed is asked about once per retry interval.
      expect(await dueIn(taken.shipmentId)).toBeGreaterThan(59.9)
      expect(await dueIn(stuck.shipmentId)).toBeGreaterThan(9.9)
      expect(await dueIn(stuck.shipmentId)).toBeLessThanOrEqual(10)
      expect((await shipment(stuck.shipmentId)).cancelRequestedAt).not.toBeNull()

      // Two more rounds: the cancel keeps failing, and what the Carrier says about either Shipment keeps arriving.
      carrier.advance(stuck.externalId, 'ready', 'confirmed')
      await due(stuck.shipmentId)
      await due(taken.shipmentId)
      await expect(track()).rejects.toBeInstanceOf(PermanentJobError)
      expect(await shipment(stuck.shipmentId)).toMatchObject({ status: 'ready' })
      carrier.advance(taken.externalId, 'delivered', 'delivered')
      await due(stuck.shipmentId)
      await due(taken.shipmentId)
      await expect(track()).rejects.toBeInstanceOf(PermanentJobError)
      expect(await shipment(taken.shipmentId)).toMatchObject({ status: 'delivered', nextCheckAt: null })

      // The Carrier's API takes the cancel again: it goes out, and the Connection is well.
      carrier.cancelFailures.clear()
      await due(stuck.shipmentId)
      await track()
      expect(await shipment(stuck.shipmentId)).toMatchObject({ status: 'cancelled', cancelRequestedAt: null })
      expect((await events(stuck.shipmentId)).at(-1)).toMatchObject(['shipment.status_changed', { from: 'ready', to: 'cancelled' }])
      expect(await connection()).toMatchObject({ health: 'ok', sync: { lastErrorKind: null } })
    })

    it('that fails for a passing reason is asked again by the job\'s retry, and after the last attempt once per interval', async () => {
      const { ctx, org, created, track, shipment, connection, dueIn } = await setup()
      const stuck = await created()
      const other = await created()
      await cancelShipment(ctx, org, stuck.shipmentId, user)
      await cancelShipment(ctx, org, other.shipmentId, user)
      ctx.queue.waiting.length = 0
      carrier.cancelFailures.set(stuck.externalId, new TransientError('503'))

      await expect(track()).rejects.toBeInstanceOf(TransientError)

      // The Carrier is likely not answering: the second cancel waits for the next run instead of timing out in turn.
      expect(carrier.calls.cancel).toEqual([stuck.externalId])
      expect(carrier.calls.track).toEqual([[stuck.externalId, other.externalId]])
      expect(await connection()).toMatchObject({ health: 'ok', sync: { lastErrorKind: 'transient' } })
      expect(await dueIn(stuck.shipmentId)).toBeLessThanOrEqual(0)
      expect(await dueIn(other.shipmentId)).toBeLessThanOrEqual(0)

      await expect(track({ attempt: 5, maxAttempts: 5, retriedLater: 0 })).rejects.toBeInstanceOf(TransientError)
      expect(await connection()).toMatchObject({ health: 'failing' })
      expect(await dueIn(stuck.shipmentId)).toBeGreaterThan(9.9)
      // The other one's cancel was never put to the Carrier, so it stays due for the next run.
      expect(await dueIn(other.shipmentId)).toBeLessThanOrEqual(0)
      expect(await shipment(stuck.shipmentId)).toMatchObject({ status: 'pending' })
    })

    it('stops the run at once when the Carrier wants a sign-in or says to slow down: that concerns every Shipment', async () => {
      const { ctx, org, created, due, track, connection, dueIn } = await setup()
      const stuck = await created()
      const other = await created()
      await cancelShipment(ctx, org, stuck.shipmentId, user)
      ctx.queue.waiting.length = 0
      carrier.cancelFailures.set(stuck.externalId, new RateLimitedError('429', { retryAfterMs: 5_000 }))
      await expect(track()).rejects.toBeInstanceOf(RetryLaterError)
      expect(carrier.calls.track).toEqual([])
      expect(await dueIn(stuck.shipmentId)).toBeLessThan(0.05)
      expect(await dueIn(other.shipmentId)).toBeLessThan(0.05)

      carrier.cancelFailures.set(stuck.externalId, new AuthExpiredError('401 token_invalid'))
      await due(stuck.shipmentId)
      await due(other.shipmentId)
      await expect(track()).rejects.toBeInstanceOf(PermanentJobError)
      expect(carrier.calls.track).toEqual([])
      expect(await connection()).toMatchObject({ health: 'auth_expired' })
      expect(await dueIn(other.shipmentId)).toBeLessThan(0.05)
    })
  })

  describe('24 hours without a confirmation', () => {
    it('fails a Shipment the Carrier still calls pending, with carrier_timeout', async () => {
      const { ctx, created, track, shipment, events } = await setup()
      const { shipmentId } = await created()
      await ctx.db.$executeRaw`UPDATE "shipment" SET "createdAt" = now() - interval '24 hours 1 minute' WHERE "id" = ${shipmentId}`
      await track()
      expect(await shipment(shipmentId)).toMatchObject({ status: 'failed', failureCode: 'carrier_timeout', nextCheckAt: null })
      expect((await events(shipmentId)).at(-1)).toEqual(['shipment.failed', { shipmentId, from: 'pending', code: 'carrier_timeout' }])
    })

    it('fails one the Carrier says nothing about, but not one it confirms just then', async () => {
      const { ctx, created, track, shipment } = await setup()
      const silent = await created()
      const confirmed = await created()
      await ctx.db.$executeRaw`UPDATE "shipment" SET "createdAt" = now() - interval '25 hours' WHERE "id" IN (${silent.shipmentId}, ${confirmed.shipmentId})`
      carrier.silent.add(silent.externalId)
      carrier.advance(confirmed.externalId, 'ready')
      await track()
      expect(await shipment(silent.shipmentId)).toMatchObject({ status: 'failed', failureCode: 'carrier_timeout' })
      expect(await shipment(confirmed.shipmentId)).toMatchObject({ status: 'ready', failureCode: null })
    })
  })

  describe('the Label', () => {
    it('is fetched once the Shipment is ready, stored sealed, served through the read service, and deleted at a final status', async () => {
      const { ctx, org, orderId, created, due, track, shipment, connection } = await setup()
      const { shipmentId, externalId } = await created()
      const file = new TextEncoder().encode('%PDF-1.7 Jan Kowalski, ul. Długa 1, 00-001 Warszawa')
      carrier.label = { contentType: 'application/pdf; name="label.pdf"', data: file }

      // Not while the Carrier has not confirmed it.
      await track()
      expect(carrier.calls.label).toEqual([])
      expect(await getShipmentLabel(ctx, org, shipmentId)).toBeNull()
      expect((await listOrderShipments(ctx, org, orderId))[0]).toMatchObject({ hasLabel: false })

      carrier.advance(externalId, 'ready')
      await due(shipmentId)
      await track()

      expect(carrier.calls.label).toEqual([externalId])
      const stored = await shipment(shipmentId)
      expect(stored.labelContentType).toBe('application/pdf')
      expect(stored.label).toMatch(/^v1:/)
      // Sealed: neither the bytes nor their base64 are in the row.
      expect(stored.label).not.toContain(Buffer.from(file).toString('base64'))
      expect(stored.label).not.toContain('Kowalski')
      expect(await getShipmentLabel(ctx, org, shipmentId)).toEqual({ contentType: 'application/pdf', extension: 'pdf', data: file })
      expect((await listOrderShipments(ctx, org, orderId))[0]).toMatchObject({ hasLabel: true })
      expect(await connection()).toMatchObject({ sync: { lastResult: { labels: 1 } } })

      // Stored, so the Carrier is not asked for it again.
      await due(shipmentId)
      await track()
      expect(carrier.calls.label).toEqual([externalId])

      carrier.advance(externalId, 'delivered')
      await due(shipmentId)
      await track()
      expect(await shipment(shipmentId)).toMatchObject({ status: 'delivered', label: null, labelContentType: null })
      expect(await getShipmentLabel(ctx, org, shipmentId)).toBeNull()
      expect((await listOrderShipments(ctx, org, orderId))[0]).toMatchObject({ hasLabel: false })
    })

    it('a Carrier without a Label yet does not fail the run; the Label comes at a later check', async () => {
      const { ctx, org, created, due, track, shipment, connection } = await setup()
      const { shipmentId, externalId } = await created()
      carrier.advance(externalId, 'ready')
      carrier.failures.label = new TransientError('invalid_action: no label yet')

      await track()

      expect(await shipment(shipmentId)).toMatchObject({ status: 'ready', label: null })
      expect(await connection()).toMatchObject({ health: 'ok', sync: { lastErrorKind: null, lastResult: { checked: 1, changed: 1, labels: 0 } } })

      carrier.failures = {}
      await due(shipmentId)
      await track()
      expect(await getShipmentLabel(ctx, org, shipmentId)).not.toBeNull()
    })

    it('is served with a type from the allow-list whatever the connector called it', async () => {
      const { ctx, org, created, track } = await setup()
      const { shipmentId, externalId } = await created()
      carrier.advance(externalId, 'ready')
      carrier.label = { contentType: 'text/html', data: new TextEncoder().encode('<script>alert(1)</script>') }
      await track()
      expect(await getShipmentLabel(ctx, org, shipmentId)).toMatchObject({ contentType: 'application/octet-stream', extension: 'bin' })
    })

    it('is not fetched for an Order whose Buyer data was erased', async () => {
      const { ctx, orderId, created, track, shipment } = await setup()
      const { shipmentId, externalId } = await created()
      carrier.advance(externalId, 'in_transit')
      await ctx.db.order.updateMany({ where: { id: orderId }, data: { buyerData: null, buyerEmailIndex: null, buyerDataErasedAt: new Date() } })
      await track()
      expect(carrier.calls.label).toEqual([])
      expect(await shipment(shipmentId)).toMatchObject({ status: 'in_transit', label: null })
    })

    it('a file that is not a Label breaks the contract: the run fails once, after the status was applied, and the Label is given up on', async () => {
      const { created, due, track, shipment, connection, view, dueIn } = await setup()
      const { shipmentId, externalId } = await created()
      carrier.advance(externalId, 'ready')
      carrier.label = { contentType: 'application/pdf', data: new Uint8Array() }
      await expect(track()).rejects.toBeInstanceOf(PermanentJobError)
      expect(await shipment(shipmentId)).toMatchObject({ status: 'ready', label: null, labelFailureCode: 'invalid' })
      expect(await connection()).toMatchObject({ health: 'failing', sync: { lastErrorKind: 'permanent' } })
      // What the panel says with it: no label could be fetched, print it at the carrier.
      expect(await view(shipmentId)).toMatchObject({ status: 'ready', hasLabel: false, labelFailureCode: 'invalid' })
      // Nobody waits for it any more.
      expect(await dueIn(shipmentId)).toBeGreaterThan(14.9)

      // Not downloaded again at every check, and the Connection is well once a run goes through.
      await due(shipmentId)
      await track()
      await due(shipmentId)
      await track()
      expect(carrier.calls.label).toEqual([externalId])
      expect(await connection()).toMatchObject({ health: 'ok', sync: { lastErrorKind: null } })
    })

    it('a Label the Carrier refuses for good for one Shipment does not cost the others theirs, and is not asked for again', async () => {
      const { ctx, org, created, due, track, shipment, connection, view } = await setup()
      const refused = await created()
      const fine = await created()
      const later = await created()
      for (const { externalId } of [refused, fine, later]) carrier.advance(externalId, 'ready')
      carrier.labelFailures.set(refused.externalId, new PermanentError('404 resource_not_found'))
      // The third is picked up in the same batch: its status must arrive whatever became of the first one's Label.
      carrier.advance(later.externalId, 'in_transit', 'collected')

      await expect(track()).rejects.toBeInstanceOf(PermanentJobError)

      expect(await connection()).toMatchObject({ health: 'failing', sync: { lastErrorKind: 'permanent' } })
      expect(carrier.calls.label).toEqual([refused.externalId, fine.externalId, later.externalId])
      expect(await shipment(refused.shipmentId)).toMatchObject({ status: 'ready', label: null, labelFailureCode: 'refused' })
      expect(await getShipmentLabel(ctx, org, fine.shipmentId)).not.toBeNull()
      expect(await shipment(later.shipmentId)).toMatchObject({ status: 'in_transit' })
      expect(await view(refused.shipmentId)).toMatchObject({ hasLabel: false, labelFailureCode: 'refused' })
      expect(await view(fine.shipmentId)).toMatchObject({ hasLabel: true, labelFailureCode: null })

      for (let round = 0; round < 2; round++) {
        await due(refused.shipmentId)
        await track()
      }
      expect(carrier.calls.label).toHaveLength(3)
      expect(await connection()).toMatchObject({ health: 'ok' })

      // Final: nothing is said about a Label nobody prints any more.
      carrier.advance(refused.externalId, 'delivered')
      await due(refused.shipmentId)
      await track()
      expect(await shipment(refused.shipmentId)).toMatchObject({ status: 'delivered', labelFailureCode: null })
    })

    it('a Label too large to store is given up on without failing the run, and not downloaded again', async () => {
      const { created, due, track, shipment, connection, view } = await setup()
      const large = await created()
      const fine = await created()
      carrier.advance(large.externalId, 'ready')
      carrier.advance(fine.externalId, 'ready')
      carrier.labels.set(large.externalId, { contentType: 'application/pdf', data: new Uint8Array(MAX_LABEL_BYTES + 1) })

      await track()

      expect(await connection()).toMatchObject({ health: 'ok', sync: { lastErrorKind: null, lastResult: { labels: 1 } } })
      expect(await shipment(large.shipmentId)).toMatchObject({ status: 'ready', label: null, labelFailureCode: 'too_large' })
      expect(await view(large.shipmentId)).toMatchObject({ hasLabel: false, labelFailureCode: 'too_large' })
      expect(await view(fine.shipmentId)).toMatchObject({ hasLabel: true, labelFailureCode: null })

      await due(large.shipmentId)
      await track()
      expect(carrier.calls.label).toEqual([large.externalId, fine.externalId])
    })
  })

  describe('a failed call', () => {
    it('credentials the Carrier no longer accepts: the Connection waits for sign-in and its Shipments stay due', async () => {
      const { created, track, shipment, connection, dueIn } = await setup()
      const { shipmentId } = await created()
      carrier.failures.track = new AuthExpiredError('401 token_invalid')
      await expect(track()).rejects.toBeInstanceOf(PermanentJobError)
      expect(await connection()).toMatchObject({ health: 'auth_expired', sync: { lastErrorKind: 'auth_expired' } })
      expect(await dueIn(shipmentId)).toBeLessThan(0.05)
      expect(await shipment(shipmentId)).toMatchObject({ status: 'pending' })
    })

    it('a transient failure gives the Shipments back to the retry, and marks the Connection failing on the last attempt', async () => {
      const { created, track, shipment, connection, dueIn } = await setup()
      const { shipmentId } = await created()
      carrier.failures.track = new TransientError('503')

      await expect(track()).rejects.toBeInstanceOf(TransientError)
      expect(await dueIn(shipmentId)).toBeLessThan(0.05)
      expect(await connection()).toMatchObject({ health: 'ok', sync: { lastErrorKind: 'transient' } })

      await expect(track({ attempt: 5, maxAttempts: 5, retriedLater: 0 })).rejects.toBeInstanceOf(TransientError)
      expect(await connection()).toMatchObject({ health: 'failing' })
      // No retry is coming: the sweep asks again after its interval, not every tick.
      expect(await dueIn(shipmentId)).toBeGreaterThan(9)
      expect(await shipment(shipmentId)).toMatchObject({ status: 'pending' })
    })

    it('a rate limit gives them back too; a refusal for good leaves them to the sweep\'s interval', async () => {
      const { created, due, track, connection, dueIn } = await setup()
      const { shipmentId } = await created()
      carrier.failures.track = new RateLimitedError('429', { retryAfterMs: 5_000 })
      await expect(track()).rejects.toBeInstanceOf(RetryLaterError)
      expect(await dueIn(shipmentId)).toBeLessThan(0.05)

      carrier.failures.track = new PermanentError('403 on the organization path')
      await due(shipmentId)
      await expect(track()).rejects.toBeInstanceOf(PermanentJobError)
      expect(await connection()).toMatchObject({ health: 'failing', sync: { lastErrorKind: 'permanent' } })
      expect(await dueIn(shipmentId)).toBeGreaterThan(9)
    })
  })

  it('does nothing for a payload naming another organization\'s Connection', async () => {
    const { ctx, carrierId, created, shipment } = await setup()
    const { shipmentId, externalId } = await created()
    carrier.advance(externalId, 'ready')
    const other = await createTestOrganization(ctx.db)
    await shipmentsTrackJob.handler(ctx, { organizationId: other, connectionId: carrierId }, jobRun)
    expect(carrier.calls.track).toEqual([])
    expect(await shipment(shipmentId)).toMatchObject({ status: 'pending' })
  })
})
