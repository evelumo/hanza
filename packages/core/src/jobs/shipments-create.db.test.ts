import { AuthExpiredError, PermanentError, RateLimitedError, TransientError } from '@hanza/connector-sdk'
import { beforeEach, describe, expect, it } from 'vitest'
import { createProduct } from '../catalog/products'
import { PermanentJobError, RetryLaterError } from '../jobs'
import { importOrder } from '../orders/import'
import { requestShipment } from '../shipments/request'
import { createTestCarrier, TEST_CARRIER_SERVICES } from '../testing/carrier'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, courierShipment, createCarrierConnection, createTestConnection, jobRun, lockerShipment, orderLine, secondsUntilDue, testChannel, user } from '../testing/fixtures'
import { shipmentsCreateJob } from './shipments-create'

const carrier = createTestCarrier({ id: 'create-carrier' })

describe.skipIf(!databaseUrl)('shipments.create', () => {
  const context = useTestContext({ connectors: [testChannel, carrier.connector] })

  beforeEach(() => {
    carrier.failures = {}
    carrier.rejectWith = null
    carrier.loseAnswers = 0
    carrier.duringCreate = null
  })

  /** A requested Shipment whose create job has not run. */
  async function setup(input: 'locker' | 'courier' = 'locker', orderOverrides: Parameters<typeof buildOrder>[0] = {}) {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const channelId = await createTestConnection(ctx, org)
    const carrierId = await createCarrierConnection(ctx, org, 'create-carrier')
    await createProduct(ctx, org, { sku: 'P', name: 'Product', stock: 10 }, user)
    const order = buildOrder({ lines: [orderLine('l1', { sku: 'P', quantity: 2 })], ...orderOverrides })
    const { orderId } = await importOrder(ctx, org, channelId, order)
    const cashOnDelivery = { amount: '49.99', currency: 'PLN' }
    const request = input === 'locker' ? lockerShipment(carrierId, { cashOnDelivery }) : courierShipment(carrierId)
    const { shipmentId } = await requestShipment(ctx, org, orderId, request, user)
    ctx.queue.waiting.length = 0

    const create = (run = jobRun) => shipmentsCreateJob.handler(ctx, { organizationId: org, shipmentId }, run)
    const shipment = () => ctx.db.shipment.findFirstOrThrow({ where: { id: shipmentId, organizationId: org } })
    const calls = () => carrier.calls.create.filter((sent) => sent.reference === shipmentId)
    const events = async () =>
      (await ctx.db.eventLog.findMany({ where: { organizationId: org, type: { startsWith: 'shipment.' } }, orderBy: { id: 'asc' } })).map((event) => [
        event.type,
        event.payload,
      ])
    const connection = async () => ({
      health: (await ctx.db.connection.findFirstOrThrow({ where: { id: carrierId } })).health,
      sync: await ctx.db.syncState.findFirst({ where: { connectionId: carrierId, stream: 'shipments_create' } }),
    })
    return { ctx, org, carrierId, order, orderId, shipmentId, create, shipment, calls, events, connection }
  }

  it('asks the Carrier with the Order\'s receiver and the confirmed pickup point, and stores its answer', async () => {
    const { ctx, order, shipmentId, create, shipment, calls, events, connection } = await setup('locker', {
      buyer: { name: 'Jan Buyer', email: 'jan@example.com', phone: '+48 600 100 200', login: 'janb' },
    })
    const requested = await shipment()

    await create()

    expect(calls()).toEqual([
      {
        reference: shipmentId,
        requestedAt: requested.createdAt.toISOString(),
        service: TEST_CARRIER_SERVICES.locker,
        receiver: { name: order.shippingAddress.name, company: null, email: 'jan@example.com', phone: '+48 600 100 200' },
        destination: { type: 'pickup_point', pointId: 'KRA010' },
        parcel: { preset: 'small' },
        cashOnDelivery: { amount: '49.99', currency: 'PLN' },
      },
    ])
    const at = carrier.byReference(shipmentId)!
    const stored = await shipment()
    expect(stored).toMatchObject({
      status: 'pending',
      externalId: at.externalId,
      trackingNumber: null,
      carrierStatus: null,
      failureCode: null,
      handedOverAt: null,
      createAttempts: 1,
      createLeaseUntil: null,
    })
    // Fresh and unconfirmed: due again at the next tick.
    const wait = await secondsUntilDue(ctx, shipmentId)
    expect(wait).toBeGreaterThan(0)
    expect(wait).toBeLessThanOrEqual(30)
    expect((await events()).map(([type]) => type)).toEqual(['shipment.requested', 'shipment.status_changed'])
    expect((await events())[1]![1]).toEqual({ shipmentId, from: 'requested', to: 'pending', carrierStatus: null })
    expect(await connection()).toMatchObject({ health: 'ok', sync: { lastResult: { created: 1 }, lastErrorKind: null } })
  })

  it('sends an address service to the Order\'s own shipping address, with the address\'s phone before the Buyer\'s', async () => {
    const address = { name: 'Anna Receiver', company: 'Receiver Ltd', street: '5 Depot Road', postalCode: '30-001', city: 'Krakow', countryCode: 'PL', phone: '+48 500 000 111', taxId: null }
    const { create, calls } = await setup('courier', { shippingAddress: address, buyer: { name: 'Jan Buyer', email: null, phone: '+48 999', login: null } })
    await create()
    expect(calls()).toMatchObject([
      {
        receiver: { name: 'Anna Receiver', company: 'Receiver Ltd', email: null, phone: '+48 500 000 111' },
        destination: { type: 'address', address },
        parcel: { lengthMm: 300, widthMm: 200, heightMm: 100, weightGrams: 1500 },
        cashOnDelivery: null,
      },
    ])
  })

  it('does nothing when run again: a Shipment with an answer is never asked for twice', async () => {
    const { create, shipment, calls, events } = await setup()
    await create()
    const first = await shipment()
    await create()
    await create()
    expect(calls()).toHaveLength(1)
    expect(await shipment()).toEqual(first)
    expect(await events()).toHaveLength(2)
  })

  it('a rejected request fails the Shipment with the Carrier\'s code, for good', async () => {
    const { shipmentId, create, shipment, calls, events, connection } = await setup()
    carrier.rejectWith = 'target_point.does_not_exist'

    await create()

    expect(await shipment()).toMatchObject({ status: 'failed', failureCode: 'target_point.does_not_exist', externalId: null, nextCheckAt: null, createLeaseUntil: null })
    expect((await events()).at(-1)).toEqual(['shipment.failed', { shipmentId, from: 'requested', code: 'target_point.does_not_exist' }])
    // The Carrier answered, so the Connection works; it is this request it will not take.
    expect(await connection()).toMatchObject({ health: 'ok', sync: { lastResult: { rejected: 1 } } })
    carrier.rejectWith = null
    await create()
    expect(calls()).toHaveLength(1)
    expect(carrier.byReference(shipmentId)).toBeUndefined()
  })

  it('a lost answer: the retry stores the Shipment the first call made, and the Carrier has exactly one', async () => {
    const { shipmentId, create, shipment, calls, connection } = await setup()
    const before = carrier.shipments.size
    carrier.loseAnswers = 1

    await expect(create()).rejects.toBeInstanceOf(TransientError)

    // The Carrier has it; Hanza does not know. The row still asks, and is free to be asked for again at once.
    const made = carrier.byReference(shipmentId)!
    expect(made).toBeDefined()
    expect(await shipment()).toMatchObject({ status: 'requested', externalId: null, createAttempts: 1, createLeaseUntil: null })
    expect((await shipment()).nextCheckAt).not.toBeNull()
    expect(await connection()).toMatchObject({ sync: { lastErrorKind: 'transient' } })

    await create({ attempt: 2, maxAttempts: 5, retriedLater: 0 })

    expect(calls()).toHaveLength(2)
    expect(calls()[1]).toEqual(calls()[0])
    expect(carrier.shipments.size).toBe(before + 1)
    expect(await shipment()).toMatchObject({ status: 'pending', externalId: made.externalId, createAttempts: 2 })
    expect(await connection()).toMatchObject({ health: 'ok', sync: { lastErrorKind: null } })
  })

  it('a second job does not ask the Carrier while the first is still asking', async () => {
    const { create, shipment, calls } = await setup()
    let arrived!: () => void
    const inFlight = new Promise<void>((resolve) => (arrived = resolve))
    let answer!: () => void
    carrier.duringCreate = () => {
      arrived()
      return new Promise<void>((resolve) => (answer = resolve))
    }

    const first = create()
    await inFlight
    expect((await shipment()).createLeaseUntil).not.toBeNull()
    await create()
    expect(calls()).toHaveLength(1)

    answer()
    await first
    expect(await shipment()).toMatchObject({ status: 'pending', createAttempts: 1, createLeaseUntil: null })
  })

  it('a lease left by a job that died runs out, and the next run asks again', async () => {
    const { ctx, shipmentId, create, shipment, calls } = await setup()
    // As a job killed in the middle of the call leaves the row.
    await ctx.db.$executeRaw`UPDATE "shipment" SET "createAttempts" = 1, "createLeaseUntil" = now() + interval '4 minutes' WHERE "id" = ${shipmentId}`
    await create()
    expect(calls()).toHaveLength(0)
    expect(await shipment()).toMatchObject({ status: 'requested', createAttempts: 1 })

    await ctx.db.$executeRaw`UPDATE "shipment" SET "createLeaseUntil" = now() - interval '1 second' WHERE "id" = ${shipmentId}`
    await create()
    expect(calls()).toHaveLength(1)
    expect(await shipment()).toMatchObject({ status: 'pending', createAttempts: 2 })
  })

  it('a Carrier that no longer accepts the credentials: the Connection waits for sign-in and the Shipment for the Connection', async () => {
    const { create, shipment, calls, events, connection } = await setup()
    carrier.failures.create = new AuthExpiredError('401 token_invalid')

    await expect(create()).rejects.toBeInstanceOf(PermanentJobError)

    expect(await connection()).toMatchObject({ health: 'auth_expired', sync: { lastErrorKind: 'auth_expired' } })
    expect(await shipment()).toMatchObject({ status: 'requested', externalId: null, failureCode: null, createLeaseUntil: null })
    expect((await shipment()).nextCheckAt).not.toBeNull()
    expect((await events()).map(([type]) => type)).toEqual(['shipment.requested'])

    // Signed in again: nothing was lost.
    carrier.failures = {}
    await create()
    expect(calls()).toHaveLength(2)
    expect(await shipment()).toMatchObject({ status: 'pending' })
    expect(await connection()).toMatchObject({ health: 'ok' })
  })

  it('a refusal of the call for good marks the Connection failing and leaves the Shipment waiting', async () => {
    const { create, shipment, connection } = await setup()
    carrier.failures.create = new PermanentError('403 on the organization path')
    await expect(create()).rejects.toBeInstanceOf(PermanentJobError)
    expect(await connection()).toMatchObject({ health: 'failing', sync: { lastErrorKind: 'permanent' } })
    expect(await shipment()).toMatchObject({ status: 'requested', createLeaseUntil: null })
  })

  it('a rate limit retries later without failing the Connection or the Shipment', async () => {
    const { create, shipment, connection } = await setup()
    carrier.failures.create = new RateLimitedError('429', { retryAfterMs: 5_000 })
    await expect(create()).rejects.toBeInstanceOf(RetryLaterError)
    expect(await connection()).toMatchObject({ health: 'unknown', sync: { lastErrorKind: 'rate_limited' } })
    expect(await shipment()).toMatchObject({ status: 'requested', createLeaseUntil: null })
  })

  it('a transient failure marks the Connection failing only on the last attempt', async () => {
    const { create, shipment, connection } = await setup()
    carrier.failures.create = new TransientError('503')
    await expect(create()).rejects.toBeInstanceOf(TransientError)
    expect(await connection()).toMatchObject({ health: 'unknown' })
    await expect(create({ attempt: 5, maxAttempts: 5, retriedLater: 0 })).rejects.toBeInstanceOf(TransientError)
    expect(await connection()).toMatchObject({ health: 'failing' })
    expect(await shipment()).toMatchObject({ status: 'requested', createAttempts: 2 })
  })

  it('an answer that breaks the contract fails the run, not the Shipment', async () => {
    const { create, shipment, connection } = await setup()
    carrier.rejectWith = 'Unknown point: KRA010, Jan Buyer'
    await expect(create()).rejects.toBeInstanceOf(PermanentJobError)
    const state = await connection()
    expect(state).toMatchObject({ health: 'failing', sync: { lastErrorKind: 'permanent' } })
    // The message names the field, never the value a Carrier put in it.
    expect(state.sync?.lastError).toContain('shipments.create')
    expect(state.sync?.lastError).not.toContain('Jan Buyer')
    expect(await shipment()).toMatchObject({ status: 'requested' })
  })

  it('erased Buyer data fails the Shipment with buyer_data_erased, without a call', async () => {
    const { ctx, orderId, shipmentId, create, shipment, calls, events } = await setup()
    await ctx.db.order.updateMany({ where: { id: orderId }, data: { buyerData: null, buyerEmailIndex: null, buyerDataErasedAt: new Date() } })

    await create()

    expect(calls()).toEqual([])
    expect(await shipment()).toMatchObject({ status: 'failed', failureCode: 'buyer_data_erased', nextCheckAt: null })
    expect((await events()).at(-1)).toEqual(['shipment.failed', { shipmentId, from: 'requested', code: 'buyer_data_erased' }])
  })

  it('an erased destination, or Buyer data that does not open, fails it as well', async () => {
    const erased = await setup()
    await erased.ctx.db.shipment.updateMany({ where: { id: erased.shipmentId }, data: { destination: null } })
    await erased.create()
    expect(await erased.shipment()).toMatchObject({ status: 'failed', failureCode: 'buyer_data_erased' })

    const damaged = await setup()
    await damaged.ctx.db.order.updateMany({ where: { id: damaged.orderId }, data: { buyerData: 'v1.damaged' } })
    await damaged.create()
    expect(await damaged.shipment()).toMatchObject({ status: 'failed', failureCode: 'buyer_data_unreadable' })
    expect(erased.calls()).toEqual([])
    expect(damaged.calls()).toEqual([])
  })

  it('a Shipment nobody answered for 24 hours fails with carrier_timeout instead of being asked for again', async () => {
    const { ctx, shipmentId, create, shipment, calls, events } = await setup()
    await ctx.db.$executeRaw`UPDATE "shipment" SET "createdAt" = now() - interval '24 hours 1 minute' WHERE "id" = ${shipmentId}`
    await create()
    expect(calls()).toEqual([])
    expect(await shipment()).toMatchObject({ status: 'failed', failureCode: 'carrier_timeout', nextCheckAt: null })
    expect((await events()).at(-1)).toEqual(['shipment.failed', { shipmentId, from: 'requested', code: 'carrier_timeout' }])
  })

  it('an answer naming a Shipment another row holds fails this one instead of asking for ever', async () => {
    const first = await setup()
    await first.create()
    const taken = (await first.shipment()).externalId!
    // A second Shipment on the same Connection, answered with the first one's Carrier id.
    const { shipmentId } = await requestShipment(first.ctx, first.org, first.orderId, lockerShipment(first.carrierId), user)
    carrier.shipments.set('duplicate', { externalId: taken, reference: shipmentId, status: 'pending', trackingNumber: null, carrierStatus: null })

    await shipmentsCreateJob.handler(first.ctx, { organizationId: first.org, shipmentId }, jobRun)

    carrier.shipments.delete('duplicate')
    expect(await first.ctx.db.shipment.findFirstOrThrow({ where: { id: shipmentId } })).toMatchObject({
      status: 'failed',
      failureCode: 'duplicate_external_id',
      externalId: null,
    })
    expect(await first.shipment()).toMatchObject({ status: 'pending', externalId: taken })
  })

  it('ignores a payload naming another organization\'s Shipment, or none', async () => {
    const { ctx, shipmentId, shipment, calls } = await setup()
    const other = await createTestOrganization(ctx.db)
    await shipmentsCreateJob.handler(ctx, { organizationId: other, shipmentId }, jobRun)
    await shipmentsCreateJob.handler(ctx, { organizationId: other, shipmentId: 'no-such-shipment' }, jobRun)
    expect(calls()).toEqual([])
    expect(await shipment()).toMatchObject({ status: 'requested', createAttempts: 0 })
  })
})
