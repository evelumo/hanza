import { randomUUID } from 'node:crypto'
import { AuthExpiredError, PermanentError, RateLimitedError, SHIPMENT_STATUSES, TransientError, isFinalShipmentStatus, type ShipmentStatus } from '@hanza/connector-sdk'
import { beforeEach, describe, expect, it } from 'vitest'
import { createProduct } from '../catalog/products'
import { PermanentJobError, RetryLaterError } from '../jobs'
import { importOrder } from '../orders/import'
import { getShipmentLabel } from '../shipments/label'
import { listOrderShipments } from '../shipments/queries'
import { requestShipment } from '../shipments/request'
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
    return { ctx, org, carrierId, orderId, created, due, track, shipment, events, connection, dueIn }
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

    it('a file that is not a Label breaks the contract and fails the run after the status was applied', async () => {
      const { created, track, shipment, connection } = await setup()
      const { shipmentId, externalId } = await created()
      carrier.advance(externalId, 'ready')
      carrier.label = { contentType: 'application/pdf', data: new Uint8Array() }
      await expect(track()).rejects.toBeInstanceOf(PermanentJobError)
      expect(await shipment(shipmentId)).toMatchObject({ status: 'ready', label: null })
      expect(await connection()).toMatchObject({ health: 'failing', sync: { lastErrorKind: 'permanent' } })
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
