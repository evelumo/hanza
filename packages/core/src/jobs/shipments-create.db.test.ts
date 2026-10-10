import { AuthExpiredError, PermanentError, RateLimitedError, SHIPMENT_CREATE_RETRY_DELAY_MS, TransientError } from '@hanza/connector-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProduct } from '../catalog/products'
import { PermanentJobError, RetryLaterError } from '../jobs'
import { importOrder } from '../orders/import'
import { RequestRefusedError } from '../rate-limit'
import { listOrderShipments } from '../shipments/queries'
import { requestShipment } from '../shipments/request'
import { createTestCarrier, TEST_CARRIER_SERVICES } from '../testing/carrier'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import {
  buildOrder,
  courierShipment,
  createCarrierConnection,
  createTestConnection,
  createWaitPasses,
  jobRun,
  lockerShipment,
  orderLine,
  secondsOfCreateLease,
  secondsUntilDue,
  testChannel,
  user,
} from '../testing/fixtures'
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

  afterEach(() => {
    vi.unstubAllGlobals()
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
    const view = async () => (await listOrderShipments(ctx, org, orderId)).find((row) => row.id === shipmentId)!
    /** The retry delay, in seconds, as the lease and the next check must show it right after a call that failed. */
    const delay = SHIPMENT_CREATE_RETRY_DELAY_MS / 1000
    const waits = async () => {
      const lease = await secondsOfCreateLease(ctx, shipmentId)
      expect(lease).toBeGreaterThan(delay - 30)
      expect(lease).toBeLessThanOrEqual(delay)
      // Due when the wait is over, so the sweep brings it back then and not before.
      const due = await secondsUntilDue(ctx, shipmentId)
      expect(due).toBeGreaterThan(delay - 30)
      expect(due).toBeLessThanOrEqual(delay)
    }
    return { ctx, org, carrierId, order, orderId, shipmentId, create, shipment, calls, events, connection, view, waits }
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
      createOutcomeUnknown: false,
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

  it('stores the Carrier\'s own status of a Shipment it has not confirmed, such as a purchase waiting for funds', async () => {
    const { shipmentId, create, shipment, events, view } = await setup()
    // What a repeat finds, or a Carrier whose purchase failed at once for a reason the seller can mend.
    carrier.shipments.set('unpaid', { externalId: 'carrier-unpaid', reference: shipmentId, status: 'pending', trackingNumber: null, carrierStatus: 'debt_collection' })

    await create()

    carrier.shipments.delete('unpaid')
    expect(await shipment()).toMatchObject({ status: 'pending', externalId: 'carrier-unpaid', carrierStatus: 'debt_collection', failureCode: null })
    expect(await view()).toMatchObject({ status: 'pending', carrierStatus: 'debt_collection', mayExistAtCarrier: false })
    expect((await events()).at(-1)).toEqual(['shipment.status_changed', { shipmentId, from: 'requested', to: 'pending', carrierStatus: 'debt_collection' }])
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
    const { shipmentId, create, shipment, calls, events, connection, view } = await setup()
    carrier.rejectWith = 'target_point.does_not_exist'

    await create()

    expect(await shipment()).toMatchObject({
      status: 'failed',
      failureCode: 'target_point.does_not_exist',
      externalId: null,
      nextCheckAt: null,
      createLeaseUntil: null,
      createOutcomeUnknown: false,
    })
    // The Carrier answered: nothing of this request exists there, and nothing says it might.
    expect((await events()).at(-1)).toEqual(['shipment.failed', { shipmentId, from: 'requested', code: 'target_point.does_not_exist' }])
    expect(await view()).toMatchObject({ status: 'failed', failureCode: 'target_point.does_not_exist', mayExistAtCarrier: false })
    // The Carrier answered, so the Connection works; it is this request it will not take.
    expect(await connection()).toMatchObject({ health: 'ok', sync: { lastResult: { rejected: 1 } } })
    carrier.rejectWith = null
    await create()
    expect(calls()).toHaveLength(1)
    expect(carrier.byReference(shipmentId)).toBeUndefined()
  })

  describe('a call whose outcome is not known', () => {
    it('a lost answer: the Carrier is not asked again by a retry that comes at once, and after the delay the retry stores the Shipment the first call made', async () => {
      const { ctx, shipmentId, create, shipment, calls, connection, view, waits } = await setup()
      const before = carrier.shipments.size
      carrier.loseAnswers = 1

      await expect(create()).rejects.toBeInstanceOf(TransientError)

      // The Carrier has it; Hanza does not know. The row still asks, but nobody may ask for it before the delay is over.
      const made = carrier.byReference(shipmentId)!
      expect(made).toBeDefined()
      expect(await shipment()).toMatchObject({ status: 'requested', externalId: null, createAttempts: 1, createOutcomeUnknown: true })
      await waits()
      expect(await view()).toMatchObject({ status: 'requested', externalId: null, mayExistAtCarrier: true })
      // This job will not ask again, so the failure is its last word on the Connection.
      expect(await connection()).toMatchObject({ health: 'failing', sync: { lastErrorKind: 'transient' } })

      // The queue's retries, 2, 4, 8 and 16 seconds later: each returns without a call, an attempt or an error.
      for (const attempt of [2, 3, 4, 5]) await create({ attempt, maxAttempts: 5, retriedLater: 0 })
      expect(calls()).toHaveLength(1)
      expect(carrier.shipments.size).toBe(before + 1)
      expect(await shipment()).toMatchObject({ status: 'requested', createAttempts: 1, createOutcomeUnknown: true })
      await waits()

      await createWaitPasses(ctx, shipmentId)
      await create()

      expect(calls()).toHaveLength(2)
      expect(calls()[1]).toEqual(calls()[0])
      expect(carrier.shipments.size).toBe(before + 1)
      expect(await shipment()).toMatchObject({ status: 'pending', externalId: made.externalId, createAttempts: 2, createOutcomeUnknown: false, createLeaseUntil: null })
      expect(await view()).toMatchObject({ mayExistAtCarrier: false })
      expect(await connection()).toMatchObject({ health: 'ok', sync: { lastErrorKind: null } })
    })

    it('an answer that could not be stored waits the same way', async () => {
      const { ctx, org, shipmentId, create, shipment, calls, waits } = await setup()
      // The Carrier answers, and the transaction that stores its answer fails.
      const db = new Proxy(ctx.db, {
        get: (target, key) => (key === '$transaction' && carrier.byReference(shipmentId) ? () => Promise.reject(new Error('database unavailable')) : Reflect.get(target, key)),
      })
      await expect(shipmentsCreateJob.handler({ ...ctx, db }, { organizationId: org, shipmentId }, jobRun)).rejects.toThrow('database unavailable')

      expect(await shipment()).toMatchObject({ status: 'requested', externalId: null, createAttempts: 1, createOutcomeUnknown: true })
      await waits()
      await create({ attempt: 2, maxAttempts: 5, retriedLater: 0 })
      expect(calls()).toHaveLength(1)

      await createWaitPasses(ctx, shipmentId)
      await create()
      expect(calls()).toHaveLength(2)
      expect(await shipment()).toMatchObject({ status: 'pending', externalId: carrier.byReference(shipmentId)!.externalId })
    })

    it('a call Hanza\'s own rate limiter refused before anything was sent is not an attempt, and its retry asks at once', async () => {
      const { create, shipment, calls, connection, view } = await setup()
      carrier.duringCreate = async () => {
        throw new RequestRefusedError('The Connection is over its request budget', { retryAfterMs: 2_000 })
      }

      await expect(create()).rejects.toBeInstanceOf(RetryLaterError)

      // Nothing left for the Carrier: no lease, no attempt, nothing that may exist there, and due at once.
      expect(await shipment()).toMatchObject({ status: 'requested', createAttempts: 0, createOutcomeUnknown: false, createLeaseUntil: null })
      expect(await view()).toMatchObject({ mayExistAtCarrier: false })
      expect(await connection()).toMatchObject({ health: 'unknown', sync: { lastErrorKind: 'rate_limited' } })

      carrier.duringCreate = null
      await create()
      expect(calls()).toHaveLength(2)
      expect(await shipment()).toMatchObject({ status: 'pending', createAttempts: 1, createOutcomeUnknown: false })
    })

    it('a refusal by the rate limiter after the lookup only read is still not an attempt; after a write was sent it is', async () => {
      const sent: string[] = []
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        sent.push(`${init?.method ?? 'GET'} ${String(input)}`)
        return new Response('{}', { status: 200 })
      })
      const refusal = () => new RequestRefusedError('The Connection is over its request budget', { retryAfterMs: 2_000 })

      // A connector that looks an earlier Shipment up and is refused the POST: only a GET left.
      const read = await setup()
      carrier.duringCreate = async (ctx) => {
        await ctx.fetch('https://carrier.example.test/shipments?reference=1')
        throw refusal()
      }
      await expect(read.create()).rejects.toBeInstanceOf(RetryLaterError)
      expect(await read.shipment()).toMatchObject({ status: 'requested', createAttempts: 0, createOutcomeUnknown: false, createLeaseUntil: null })

      // A connector whose POST left, and which was then refused a request after it: the Carrier may have made it.
      const written = await setup()
      carrier.duringCreate = async (ctx) => {
        await ctx.fetch('https://carrier.example.test/shipments', { method: 'POST', body: '{}' })
        throw refusal()
      }
      await expect(written.create()).rejects.toBeInstanceOf(RetryLaterError)
      expect(await written.shipment()).toMatchObject({ status: 'requested', createAttempts: 1, createOutcomeUnknown: true })
      await written.waits()
      carrier.duringCreate = null
      // The queue brings the job back when the limiter said to: it does nothing before the delay is over.
      await written.create({ attempt: 1, maxAttempts: 5, retriedLater: 1 })
      expect(written.calls()).toHaveLength(1)
      expect(sent).toEqual(['GET https://carrier.example.test/shipments?reference=1', 'POST https://carrier.example.test/shipments'])
    })

    it('the sweep of sync.tick leaves it alone while the delay runs, and takes it when the delay is over', async () => {
      const { ctx, org, carrierId, shipmentId, create, calls } = await setup()
      const { claimDueShipmentCreates } = await import('../shipments/claims')
      carrier.loseAnswers = 1
      await expect(create()).rejects.toBeInstanceOf(TransientError)

      // Even if something made it due (a person asking to cancel does), a claim would only postpone the job that may ask.
      await ctx.db.$executeRaw`UPDATE "shipment" SET "nextCheckAt" = now() - interval '1 second' WHERE "id" = ${shipmentId}`
      expect(await claimDueShipmentCreates(ctx, org, carrierId, 100)).toEqual([])

      await createWaitPasses(ctx, shipmentId)
      expect(await claimDueShipmentCreates(ctx, org, carrierId, 100)).toEqual([shipmentId])
      await create()
      expect(calls()).toHaveLength(2)
    })
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

  it('a lease left by a job that died runs out, and the next run asks again, knowing that a Shipment may exist', async () => {
    const { ctx, shipmentId, create, shipment, calls } = await setup()
    // As a job killed in the middle of the call leaves the row: the attempt counted, the lease running, no word on the outcome.
    await ctx.db.$executeRaw`UPDATE "shipment" SET "createAttempts" = 1, "createLeaseUntil" = now() + interval '4 minutes' WHERE "id" = ${shipmentId}`
    await create()
    expect(calls()).toHaveLength(0)
    expect(await shipment()).toMatchObject({ status: 'requested', createAttempts: 1 })

    await ctx.db.$executeRaw`UPDATE "shipment" SET "createLeaseUntil" = now() - interval '1 second' WHERE "id" = ${shipmentId}`
    carrier.failures.create = new TransientError('503')
    await expect(create()).rejects.toBeInstanceOf(TransientError)
    // The attempt before this one left the row waiting, so it ended without an answer.
    expect(await shipment()).toMatchObject({ status: 'requested', createAttempts: 2, createOutcomeUnknown: true })

    carrier.failures = {}
    await createWaitPasses(ctx, shipmentId)
    await create()
    expect(calls()).toHaveLength(2)
    expect(await shipment()).toMatchObject({ status: 'pending', createAttempts: 3, createOutcomeUnknown: false })
  })

  it('a Carrier that no longer accepts the credentials: the Connection waits for sign-in and the Shipment for the Connection', async () => {
    const { ctx, shipmentId, create, shipment, calls, events, connection, waits } = await setup()
    carrier.failures.create = new AuthExpiredError('401 token_invalid')

    await expect(create()).rejects.toBeInstanceOf(PermanentJobError)

    expect(await connection()).toMatchObject({ health: 'auth_expired', sync: { lastErrorKind: 'auth_expired' } })
    expect(await shipment()).toMatchObject({ status: 'requested', externalId: null, failureCode: null })
    await waits()
    expect((await events()).map(([type]) => type)).toEqual(['shipment.requested'])

    // Signed in again, later than the delay: nothing was lost.
    carrier.failures = {}
    await createWaitPasses(ctx, shipmentId)
    await create()
    expect(calls()).toHaveLength(2)
    expect(await shipment()).toMatchObject({ status: 'pending' })
    expect(await connection()).toMatchObject({ health: 'ok' })
  })

  it('a refusal of the call for good (the account, not this request) marks the Connection failing and leaves the Shipment waiting', async () => {
    const { create, shipment, connection, waits } = await setup()
    // What a connector throws for no funds or no contract: never `rejected`, which would fail the Shipment for good.
    carrier.failures.create = new PermanentError('403 on the organization path')
    await expect(create()).rejects.toBeInstanceOf(PermanentJobError)
    expect(await connection()).toMatchObject({ health: 'failing', sync: { lastErrorKind: 'permanent' } })
    expect(await shipment()).toMatchObject({ status: 'requested', failureCode: null })
    await waits()
  })

  it('a Carrier\'s own rate limit retries later without failing the Connection or the Shipment, and waits like any sent request', async () => {
    const { create, shipment, calls, connection, waits } = await setup()
    carrier.failures.create = new RateLimitedError('429', { retryAfterMs: 5_000 })
    await expect(create()).rejects.toBeInstanceOf(RetryLaterError)
    expect(await connection()).toMatchObject({ health: 'unknown', sync: { lastErrorKind: 'rate_limited' } })
    expect(await shipment()).toMatchObject({ status: 'requested' })
    await waits()
    // Five seconds later the queue runs the job again: the 429 may have followed a request that went through.
    carrier.failures = {}
    await create({ attempt: 1, maxAttempts: 5, retriedLater: 1 })
    expect(calls()).toHaveLength(1)
  })

  it('a transient failure marks the Connection failing at once: no retry of the job asks again', async () => {
    const { ctx, shipmentId, create, shipment, calls, connection } = await setup()
    carrier.failures.create = new TransientError('503')
    await expect(create()).rejects.toBeInstanceOf(TransientError)
    expect(await connection()).toMatchObject({ health: 'failing', sync: { lastErrorKind: 'transient' } })
    // The retries of the queue do not reach the Carrier and do not clear what the failed call recorded.
    await create({ attempt: 2, maxAttempts: 5, retriedLater: 0 })
    await create({ attempt: 5, maxAttempts: 5, retriedLater: 0 })
    expect(calls()).toHaveLength(1)
    expect(await connection()).toMatchObject({ health: 'failing', sync: { lastErrorKind: 'transient' } })
    expect(await shipment()).toMatchObject({ status: 'requested', createAttempts: 1 })

    // The Carrier is back when the delay is over.
    carrier.failures = {}
    await createWaitPasses(ctx, shipmentId)
    await create()
    expect(await connection()).toMatchObject({ health: 'ok' })
    expect(await shipment()).toMatchObject({ status: 'pending', createAttempts: 2 })
  })

  it('an answer that breaks the contract fails the run, not the Shipment, which waits: the Carrier may have made one', async () => {
    const { create, shipment, connection, waits } = await setup()
    carrier.rejectWith = 'Unknown point: KRA010, Jan Buyer'
    await expect(create()).rejects.toBeInstanceOf(PermanentJobError)
    const state = await connection()
    expect(state).toMatchObject({ health: 'failing', sync: { lastErrorKind: 'permanent' } })
    // The message names the field, never the value a Carrier put in it.
    expect(state.sync?.lastError).toContain('shipments.create')
    expect(state.sync?.lastError).not.toContain('Jan Buyer')
    expect(await shipment()).toMatchObject({ status: 'requested', createOutcomeUnknown: true })
    await waits()
  })

  it('refuses an id or a tracking number that is not a short id, so free text never reaches a plaintext column', async () => {
    const { ctx, shipmentId, create, shipment, connection } = await setup()
    carrier.duringCreate = async () => {
      carrier.shipments.set('bad', { externalId: 'x'.repeat(8192), reference: shipmentId, status: 'pending', trackingNumber: null, carrierStatus: null })
    }
    await expect(create()).rejects.toBeInstanceOf(PermanentJobError)
    expect(await shipment()).toMatchObject({ status: 'requested', externalId: null, trackingNumber: null })
    expect((await connection()).sync?.lastError).toContain('externalId')

    carrier.shipments.set('bad', { externalId: 'carrier-bad', reference: shipmentId, status: 'pending', trackingNumber: 'Jan Kowalski, ul. Długa 1', carrierStatus: null })
    carrier.duringCreate = null
    await createWaitPasses(ctx, shipmentId)
    await expect(create()).rejects.toBeInstanceOf(PermanentJobError)
    expect(await shipment()).toMatchObject({ status: 'requested', externalId: null, trackingNumber: null })
    expect((await connection()).sync?.lastError).toContain('trackingNumber')
    expect((await connection()).sync?.lastError).not.toContain('Kowalski')
    carrier.shipments.delete('bad')
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

  describe('24 hours without an answer', () => {
    it('fails a Shipment the Carrier was never asked for with carrier_timeout instead of asking', async () => {
      const { ctx, shipmentId, create, shipment, calls, events, view } = await setup()
      await ctx.db.$executeRaw`UPDATE "shipment" SET "createdAt" = now() - interval '24 hours 1 minute' WHERE "id" = ${shipmentId}`
      await create()
      expect(calls()).toEqual([])
      expect(await shipment()).toMatchObject({ status: 'failed', failureCode: 'carrier_timeout', nextCheckAt: null, createOutcomeUnknown: false })
      expect((await events()).at(-1)).toEqual(['shipment.failed', { shipmentId, from: 'requested', code: 'carrier_timeout' }])
      expect(await view()).toMatchObject({ status: 'failed', failureCode: 'carrier_timeout', mayExistAtCarrier: false })
    })

    it('does not fire while the delay after a failed call runs, and says afterwards that a Shipment may exist at the Carrier', async () => {
      const { ctx, shipmentId, create, shipment, calls, events, view } = await setup()
      // Asked a minute before the 24 hours are over; the answer is lost.
      await ctx.db.$executeRaw`UPDATE "shipment" SET "createdAt" = now() - interval '23 hours 59 minutes' WHERE "id" = ${shipmentId}`
      carrier.loseAnswers = 1
      await expect(create()).rejects.toBeInstanceOf(TransientError)
      await ctx.db.$executeRaw`UPDATE "shipment" SET "createdAt" = now() - interval '24 hours 1 minute' WHERE "id" = ${shipmentId}`

      // Too old, but the wait is in force: the job that comes now neither asks nor times it out.
      await create()
      expect(await shipment()).toMatchObject({ status: 'requested', failureCode: null })

      await createWaitPasses(ctx, shipmentId)
      await create()

      expect(calls()).toHaveLength(1)
      expect(await shipment()).toMatchObject({ status: 'failed', failureCode: 'carrier_timeout', nextCheckAt: null, createLeaseUntil: null, createOutcomeUnknown: true })
      expect((await events()).at(-1)).toEqual(['shipment.failed', { shipmentId, from: 'requested', code: 'carrier_timeout', createAttempted: true }])
      // What the panel warns with: a label may have been bought, and only the Carrier's own panel can tell.
      expect(await view()).toMatchObject({ status: 'failed', failureCode: 'carrier_timeout', externalId: null, mayExistAtCarrier: true })
    })

    it('does not fire while a job holds the lease, so the answer of a call in flight is not dropped for it', async () => {
      const { ctx, shipmentId, create, shipment } = await setup()
      const { timeOutShipmentRequest } = await import('../shipments/apply-state')
      let arrived!: () => void
      const inFlight = new Promise<void>((resolve) => (arrived = resolve))
      let answer!: () => void
      carrier.duringCreate = () => {
        arrived()
        return new Promise<void>((resolve) => (answer = resolve))
      }
      const first = create()
      await inFlight
      await ctx.db.$executeRaw`UPDATE "shipment" SET "createdAt" = now() - interval '24 hours 1 minute' WHERE "id" = ${shipmentId}`

      // Neither a second job nor the timeout itself, called directly, touches it.
      await create()
      expect(await timeOutShipmentRequest(ctx, (await shipment()).organizationId, shipmentId)).toBe(false)
      expect(await shipment()).toMatchObject({ status: 'requested', failureCode: null })

      answer()
      await first
      // The Carrier's id is stored, so the Shipment is followed, whatever becomes of it.
      expect((await shipment()).externalId).toBe(carrier.byReference(shipmentId)!.externalId)
    })
  })

  it('logs the Carrier\'s id of an answer it has to drop because the Shipment was made final meanwhile', async () => {
    const { ctx, org, carrierId, shipmentId, shipment, events } = await setup()
    const logged: Array<[string, Record<string, unknown> | undefined]> = []
    const watched = { ...ctx, log: { ...ctx.log, error: (message: string, fields?: Record<string, unknown>) => void logged.push([message, fields]) } }
    // While the Carrier is being asked, the Order's Buyer data is erased and another job fails the Shipment for it.
    carrier.duringCreate = async () => {
      await ctx.db.shipment.updateMany({ where: { id: shipmentId }, data: { status: 'failed', failureCode: 'buyer_data_erased', nextCheckAt: null } })
    }

    await shipmentsCreateJob.handler(watched, { organizationId: org, shipmentId }, jobRun)

    const externalId = carrier.byReference(shipmentId)!.externalId
    expect(await shipment()).toMatchObject({ status: 'failed', failureCode: 'buyer_data_erased', externalId: null })
    expect(logged).toEqual([['shipment create answer dropped', { organizationId: org, connectionId: carrierId, shipmentId, externalId, reason: 'final' }]])
    expect((await events()).map(([type]) => type)).toEqual(['shipment.requested'])
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
