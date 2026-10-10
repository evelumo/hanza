import { describe, expect, it } from 'vitest'
import { createProduct } from '../catalog/products'
import { shipmentsCreateJob } from '../jobs/shipments-create'
import { createConnection } from '../connections/connections'
import type { Context } from '../context'
import { changeOrderStatus } from '../orders/change-status'
import { importOrder } from '../orders/import'
import { createTestCarrier, TEST_CARRIER_SERVICES } from '../testing/carrier'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, courierShipment, createCarrierConnection, createTestConnection, jobRun, lockerShipment, orderLine, secondsUntilDue, testChannel, user } from '../testing/fixtures'
import { cancelShipment } from './cancel'
import { requestShipment, type ShipmentInput } from './request'
import { openDestination } from './sealed'

const carrier = createTestCarrier({ id: 'request-carrier' })

describe.skipIf(!databaseUrl)('requestShipment', () => {
  const context = useTestContext({ connectors: [testChannel, carrier.connector] })

  async function setup(overrides: Parameters<typeof buildOrder>[0] = {}) {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const channelId = await createTestConnection(ctx, org)
    const carrierId = await createCarrierConnection(ctx, org, 'request-carrier')
    await createProduct(ctx, org, { sku: 'P', name: 'Product', stock: 10 }, user)
    const { orderId } = await importOrder(ctx, org, channelId, buildOrder({ lines: [orderLine('l1', { sku: 'P', quantity: 2 })], ...overrides }))
    ctx.queue.waiting.length = 0
    const shipments = () => ctx.db.shipment.findMany({ where: { organizationId: org }, orderBy: { id: 'asc' } })
    const shipmentEvents = async () =>
      (await ctx.db.eventLog.findMany({ where: { organizationId: org, type: { startsWith: 'shipment.' } }, orderBy: { id: 'asc' } })).map((event) => ({
        type: event.type,
        subjectId: event.subjectId,
        payload: event.payload,
      }))
    /** Every refusal must leave nothing behind: no row, no Event, no job. */
    const refuses = async (input: ShipmentInput, code: string, details?: Record<string, unknown>) => {
      const enqueued = ctx.queue.enqueued.length
      await expect(requestShipment(ctx, org, orderId, input, user)).rejects.toMatchObject({ name: 'DomainError', code, ...(details ? { details } : {}) })
      expect(await shipments()).toEqual([])
      expect(await shipmentEvents()).toEqual([])
      expect(ctx.queue.enqueued).toHaveLength(enqueued)
    }
    return { ctx, org, channelId, carrierId, orderId, shipments, shipmentEvents, refuses }
  }

  it('stores the request as a Shipment that is due at once, with the destination sealed, and enqueues its create', async () => {
    const { ctx, org, carrierId, orderId, shipments, shipmentEvents } = await setup()

    const { shipmentId } = await requestShipment(
      ctx,
      org,
      orderId,
      lockerShipment(carrierId, { parcel: { preset: 'large' }, cashOnDelivery: { amount: '129.90', currency: 'PLN' } }),
      user,
    )

    const [row] = await shipments()
    expect(row).toMatchObject({
      id: shipmentId,
      orderId,
      connectionId: carrierId,
      status: 'requested',
      service: TEST_CARRIER_SERVICES.locker,
      parcel: { preset: 'large' },
      codCurrency: 'PLN',
      externalId: null,
      trackingNumber: null,
      label: null,
      labelContentType: null,
      handedOverAt: null,
      cancelRequestedAt: null,
      createAttempts: 0,
      createLeaseUntil: null,
      createdByUserId: 'user-1',
    })
    expect(row!.codAmount!.toFixed()).toBe('129.9')
    // Due at once, on the database's clock.
    const due = await secondsUntilDue(ctx, shipmentId)
    expect(due).toBeLessThanOrEqual(0)
    expect(due).toBeGreaterThan(-30)
    // Sealed and bound to this Shipment: the pickup point is in no plaintext column.
    expect(row!.destination).toMatch(/^v1:/)
    expect(JSON.stringify(row)).not.toContain('KRA010')
    expect(openDestination(ctx.secrets, { organizationId: org, shipmentId }, row!.destination!)).toEqual({ type: 'pickup_point', pointId: 'KRA010' })

    expect(await shipmentEvents()).toEqual([
      {
        type: 'shipment.requested',
        subjectId: orderId,
        payload: { shipmentId, connectionId: carrierId, service: TEST_CARRIER_SERVICES.locker, actor: user },
      },
    ])
    expect(ctx.queue.waiting).toEqual([
      { name: 'shipments.create', payload: { organizationId: org, shipmentId }, options: { coalesceKey: `shipments.create:${shipmentId}` } },
    ])
    // The Carrier is asked by the job, never by the request.
    expect(carrier.calls.create.filter((request) => request.reference === shipmentId)).toEqual([])
  })

  it('takes an address service for the Order\'s own address, which is not copied to the Shipment', async () => {
    const { ctx, org, carrierId, orderId, shipments } = await setup()
    const { shipmentId } = await requestShipment(ctx, org, orderId, courierShipment(carrierId), user)
    const [row] = await shipments()
    expect(row).toMatchObject({ service: TEST_CARRIER_SERVICES.courier, parcel: { lengthMm: 300, widthMm: 200, heightMm: 100, weightGrams: 1500 }, codAmount: null })
    expect(openDestination(ctx.secrets, { organizationId: org, shipmentId }, row!.destination!)).toEqual({ type: 'address' })
  })

  it('takes a processing Order, and an Order with a second Shipment', async () => {
    const { ctx, org, carrierId, orderId, shipments } = await setup()
    await changeOrderStatus(ctx, org, orderId, 'processing', user)
    await requestShipment(ctx, org, orderId, lockerShipment(carrierId), user)
    await requestShipment(ctx, org, orderId, courierShipment(carrierId), user)
    expect(await shipments()).toHaveLength(2)
  })

  describe('a second request for the same Order, Connection and service', () => {
    it('is refused while the first still waits for the Carrier: a double click buys one label', async () => {
      const { ctx, org, carrierId, orderId, shipments, shipmentEvents } = await setup()
      const first = await requestShipment(ctx, org, orderId, lockerShipment(carrierId), user)
      const enqueued = ctx.queue.enqueued.length

      // The same form sent again, and the same service to another point by another member: neither makes a row.
      await expect(requestShipment(ctx, org, orderId, lockerShipment(carrierId), user)).rejects.toMatchObject({
        name: 'DomainError',
        code: 'shipment_already_requested',
        details: { shipmentId: first.shipmentId },
      })
      const other = lockerShipment(carrierId, { parcel: { preset: 'large' }, destination: { type: 'pickup_point', pointId: 'WAW22A' } })
      await expect(requestShipment(ctx, org, orderId, other, { type: 'user', userId: 'user-2' })).rejects.toMatchObject({ code: 'shipment_already_requested' })

      expect((await shipments()).map((row) => row.id)).toEqual([first.shipmentId])
      expect(await shipmentEvents()).toHaveLength(1)
      expect(ctx.queue.enqueued).toHaveLength(enqueued)
    })

    it('two requests sent at the same moment make one Shipment', async () => {
      const { ctx, org, carrierId, orderId, shipments } = await setup()
      const results = await Promise.allSettled([
        requestShipment(ctx, org, orderId, lockerShipment(carrierId), user),
        requestShipment(ctx, org, orderId, lockerShipment(carrierId), user),
      ])
      expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
      expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'shipment_already_requested' } })
      expect(await shipments()).toHaveLength(1)
    })

    it('is taken once the first is at the Carrier, or cancelled, and for another service or Connection at any time', async () => {
      const { ctx, org, carrierId, orderId, shipments } = await setup()
      const first = await requestShipment(ctx, org, orderId, lockerShipment(carrierId), user)
      // Another service, and the same service through another Connection, are other parcels.
      await requestShipment(ctx, org, orderId, courierShipment(carrierId), user)
      const secondCarrier = await createCarrierConnection(ctx, org, 'request-carrier')
      await requestShipment(ctx, org, orderId, lockerShipment(secondCarrier), user)
      // Another Order is not concerned either.
      const channelId = (await ctx.db.order.findFirstOrThrow({ where: { id: orderId } })).connectionId
      const { orderId: otherOrder } = await importOrder(ctx, org, channelId, buildOrder({ lines: [orderLine('l1', { sku: 'P', quantity: 1 })] }))
      await requestShipment(ctx, org, otherOrder, lockerShipment(carrierId), user)

      // The Carrier has the first one: an Order may have several Shipments.
      await shipmentsCreateJob.handler(ctx, { organizationId: org, shipmentId: first.shipmentId }, jobRun)
      expect(await ctx.db.shipment.findFirstOrThrow({ where: { id: first.shipmentId } })).toMatchObject({ status: 'pending' })
      const second = await requestShipment(ctx, org, orderId, lockerShipment(carrierId), user)

      // And a requested one that was cancelled no longer stands in the way.
      expect(await cancelShipment(ctx, org, second.shipmentId, user)).toEqual({ outcome: 'cancelled' })
      await requestShipment(ctx, org, orderId, lockerShipment(carrierId), user)
      expect((await shipments()).filter((row) => row.orderId === orderId)).toHaveLength(5)
    })
  })

  it('trims the pickup point a person typed', async () => {
    const { ctx, org, carrierId, orderId } = await setup()
    const { shipmentId } = await requestShipment(ctx, org, orderId, lockerShipment(carrierId, { destination: { type: 'pickup_point', pointId: '  WAW22A ' } }), user)
    const row = await ctx.db.shipment.findFirstOrThrow({ where: { id: shipmentId } })
    expect(openDestination(ctx.secrets, { organizationId: org, shipmentId }, row.destination!)).toEqual({ type: 'pickup_point', pointId: 'WAW22A' })
  })

  it('does not fail when the enqueue after commit does: the row stays requested and due for the tick', async () => {
    const { ctx, org, carrierId, orderId, shipments } = await setup()
    const queueDown: Context = {
      ...ctx,
      queue: {
        ...ctx.queue,
        enqueue: async () => {
          throw new Error('Redis unavailable')
        },
      },
    }
    await requestShipment(queueDown, org, orderId, lockerShipment(carrierId), user)
    const [row] = await shipments()
    expect(row).toMatchObject({ status: 'requested' })
    expect(row!.nextCheckAt).not.toBeNull()
    expect(ctx.queue.waiting).toEqual([])
  })

  describe('refuses', () => {
    it('an Order that is shipped or cancelled', async () => {
      for (const phase of ['shipped', 'cancelled'] as const) {
        const { ctx, org, carrierId, orderId, refuses } = await setup()
        await changeOrderStatus(ctx, org, orderId, phase, user)
        ctx.queue.waiting.length = 0
        await refuses(lockerShipment(carrierId), 'shipment_order_closed')
      }
    })

    it('an Order awaiting payment', async () => {
      const { carrierId, refuses } = await setup({ awaitingPayment: true })
      await refuses(lockerShipment(carrierId), 'awaiting_payment')
    })

    it('an Order or a Connection the organization does not have', async () => {
      const { ctx, org, carrierId, refuses } = await setup()
      await refuses(lockerShipment('no-such-connection'), 'not_found')
      const other = await createTestOrganization(ctx.db)
      const otherCarrier = await createCarrierConnection(ctx, other, 'request-carrier')
      await refuses(lockerShipment(otherCarrier), 'not_found')
      await expect(requestShipment(ctx, org, 'no-such-order', lockerShipment(carrierId), user)).rejects.toMatchObject({ code: 'not_found' })
    })

    it('a Connection whose connector makes no Shipments, or is not installed', async () => {
      const { ctx, org, channelId, refuses } = await setup()
      await refuses(lockerShipment(channelId), 'not_a_carrier')
      const { connectionId: gone } = await createConnection(ctx, org, { connectorId: 'uninstalled', name: 'Gone', config: {}, credentials: {} }, user)
      await refuses(lockerShipment(gone), 'unknown_connector')
    })

    it('a service the connector does not declare', async () => {
      const { carrierId, refuses } = await setup()
      await refuses(lockerShipment(carrierId, { service: 'test_drone' }), 'shipment_service_unknown')
    })

    it('a pickup point service without a pickup point', async () => {
      const { carrierId, refuses } = await setup()
      await refuses(lockerShipment(carrierId, { destination: { type: 'address' } }), 'shipment_pickup_point_required')
      await refuses(lockerShipment(carrierId, { destination: { type: 'pickup_point', pointId: '   ' } }), 'shipment_pickup_point_required')
    })

    it('a request that does not fit its service, saying which part', async () => {
      const { carrierId, refuses } = await setup()
      const invalid = 'shipment_request_invalid'
      await refuses(courierShipment(carrierId, { destination: { type: 'pickup_point', pointId: 'KRA010' } }), invalid, { problem: 'destination_type' })
      await refuses(courierShipment(carrierId, { parcel: { preset: 'small' } }), invalid, { problem: 'parcel_type' })
      await refuses(lockerShipment(carrierId, { parcel: { lengthMm: 1, widthMm: 1, heightMm: 1, weightGrams: 1 } }), invalid, { problem: 'parcel_type' })
      await refuses(lockerShipment(carrierId, { parcel: { preset: 'pallet' } }), invalid, { problem: 'parcel_preset' })
      await refuses(courierShipment(carrierId, { cashOnDelivery: { amount: '10.00', currency: 'PLN' } }), invalid, { problem: 'cash_on_delivery' })
    })

    it('a malformed request: a parcel that is neither a preset nor dimensions, an amount that is not money', async () => {
      const { carrierId, refuses } = await setup()
      const invalid = 'shipment_request_invalid'
      await refuses(courierShipment(carrierId, { parcel: { lengthMm: 300, widthMm: 200, heightMm: 0, weightGrams: 1500 } }), invalid, { problem: 'parcel' })
      await refuses(lockerShipment(carrierId, { parcel: { preset: 'small', weightGrams: 5 } as never }), invalid, { problem: 'parcel' })
      await refuses(lockerShipment(carrierId, { cashOnDelivery: { amount: '10,50', currency: 'PLN' } }), invalid, { problem: 'cashOnDelivery' })
      await refuses(lockerShipment(carrierId, { cashOnDelivery: { amount: '0.00', currency: 'PLN' } }), invalid, { problem: 'cash_on_delivery_amount' })
      await refuses(lockerShipment(carrierId, { cashOnDelivery: { amount: '10.505', currency: 'PLN' } }), invalid, { problem: 'cash_on_delivery_amount' })
    })

    it('an Order whose Buyer data was erased, or does not open', async () => {
      const erased = await setup()
      await erased.ctx.db.order.updateMany({ where: { id: erased.orderId }, data: { buyerData: null, buyerEmailIndex: null, buyerDataErasedAt: new Date() } })
      await erased.refuses(lockerShipment(erased.carrierId), 'shipment_buyer_data_erased')

      const damaged = await setup()
      await damaged.ctx.db.order.updateMany({ where: { id: damaged.orderId }, data: { buyerData: 'v1.damaged' } })
      await damaged.refuses(lockerShipment(damaged.carrierId), 'shipment_buyer_data_unreadable')
    })
  })
})
