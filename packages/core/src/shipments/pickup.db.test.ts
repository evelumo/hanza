import { createDb, type Db } from '@hanza/db'
import { beforeEach, describe, expect, it } from 'vitest'
import { upsertOffers } from '../catalog/offers'
import { createProduct } from '../catalog/products'
import { shipmentsCreateJob } from '../jobs/shipments-create'
import { shipmentsTrackJob } from '../jobs/shipments-track'
import { createOrderStatus } from '../order-statuses/statuses'
import { resolveAttention } from '../orders/attention'
import { changeOrderStatus } from '../orders/change-status'
import { importOrder } from '../orders/import'
import { linkOrderLine } from '../orders/link-line'
import { getAvailability } from '../stock/availability'
import { createTestCarrier } from '../testing/carrier'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { addMember, buildOrder, createCarrierConnection, createTestConnection, defaultStatusId, fact, jobRun, lockerShipment, orderLine, testChannel, user } from '../testing/fixtures'
import { countLockWaits, uniqueApplicationName } from '../testing/lock-waits'
import { TX_OPTIONS } from '../transaction'
import { requestShipment } from './request'

// A Carrier taking a parcel ships the Order (ADR 0024). It consumes Reservations, so every test here checks Stock.

const carrier = createTestCarrier({ id: 'pickup-carrier' })
const applicationName = uniqueApplicationName('hanza-pickup')

describe.skipIf(!databaseUrl)('a carrier pickup ships the Order', () => {
  const context = useTestContext({ applicationName, connectors: [testChannel, carrier.connector] })

  beforeEach(() => {
    carrier.loseAnswers = 0
    context().queue.waiting.length = 0
  })

  /** An Order of 2 units of a Product with Stock 10, on a Channel that takes status pushes. */
  async function setup(orderOverrides: Parameters<typeof buildOrder>[0] = {}) {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const channelId = await createTestConnection(ctx, org)
    const carrierId = await createCarrierConnection(ctx, org, 'pickup-carrier')
    const { productId } = await createProduct(ctx, org, { sku: 'P', name: 'Product', stock: 10 }, user)
    await upsertOffers(ctx, org, channelId, [{ externalId: 'offer-p', sku: 'P', name: 'Offer', url: null }], new Date())
    const { orderId } = await importOrder(ctx, org, channelId, buildOrder({ lines: [orderLine('l1', { sku: 'P', quantity: 2 })], ...orderOverrides }))
    ctx.queue.waiting.length = 0

    /** A Shipment of the Order that the Carrier has confirmed nothing about yet. */
    const shipmentOf = async (id = orderId) => {
      const { shipmentId } = await requestShipment(ctx, org, id, lockerShipment(carrierId), user)
      await shipmentsCreateJob.handler(ctx, { organizationId: org, shipmentId }, jobRun)
      ctx.queue.waiting.length = 0
      return { shipmentId, externalId: carrier.byReference(shipmentId)!.externalId }
    }
    /** The Carrier reports `status` for the Shipment, and the track job hears of it. */
    const carrierSays = async (shipment: { shipmentId: string; externalId: string }, status: Parameters<typeof carrier.advance>[1]) => {
      carrier.advance(shipment.externalId, status)
      await ctx.db.$executeRaw`UPDATE "shipment" SET "nextCheckAt" = now() - interval '1 second' WHERE "id" = ${shipment.shipmentId}`
      await shipmentsTrackJob.handler(ctx, { organizationId: org, connectionId: carrierId }, jobRun)
    }
    const order = () => ctx.db.order.findFirstOrThrow({ where: { id: orderId, organizationId: org }, include: { lines: { include: { reservation: true } } } })
    const available = async () => (await getAvailability(ctx.db, org, [productId])).get(productId)!
    const count = (type: string) => ctx.db.eventLog.count({ where: { organizationId: org, type } })
    const statusChanges = async () =>
      (await ctx.db.eventLog.findMany({ where: { organizationId: org, type: 'order.status_changed' }, orderBy: { id: 'asc' } })).map((event) => event.payload)
    const shipment = (shipmentId: string) => ctx.db.shipment.findFirstOrThrow({ where: { id: shipmentId, organizationId: org } })
    return { ctx, org, channelId, carrierId, productId, orderId, shipmentOf, carrierSays, order, available, count, statusChanges, shipment }
  }

  it('moves the Order to shipped: Reservations consumed once, closedAt set, the push to the Channel pending', async () => {
    const { ctx, org, channelId, orderId, shipmentOf, carrierSays, order, available, count, statusChanges, shipment } = await setup()
    const parcel = await shipmentOf()
    const shippedStatus = await defaultStatusId(ctx, org, 'shipped')
    const newStatus = await defaultStatusId(ctx, org, 'new')
    expect(await available()).toEqual({ stock: 10, reserved: 2, available: 8 })

    await carrierSays(parcel, 'in_transit')

    const shipped = await order()
    expect(shipped).toMatchObject({ phase: 'shipped', statusId: shippedStatus, attentionReasons: [], statusPushSeq: 1 })
    expect(shipped.closedAt).not.toBeNull()
    expect(shipped.statusPushDueAt!.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000)
    expect(shipped.lines.map((line) => [line.reservation?.status, line.reservation?.units])).toEqual([['consumed', 2]])
    expect(await available()).toEqual({ stock: 8, reserved: 0, available: 8 })
    expect(await count('stock.consumed')).toBe(1)
    expect((await shipment(parcel.shipmentId)).handedOverAt).not.toBeNull()

    // The system moved it, to the status a person choosing "shipped" would get, and the Event names the Shipment.
    expect(await statusChanges()).toEqual([
      {
        from: 'new',
        to: 'shipped',
        fromStatus: { id: newStatus, name: null, phase: 'new' },
        toStatus: { id: shippedStatus, name: null, phase: 'shipped' },
        cause: 'shipment',
        factId: null,
        shipmentId: parcel.shipmentId,
        actor: { type: 'system' },
      },
    ])
    // After commit: the Channel is told the phase and the new Available.
    expect(ctx.queue.waiting).toEqual(
      expect.arrayContaining([
        { name: 'orders.updateStatus', payload: { organizationId: org, orderId }, options: { coalesceKey: `orders.updateStatus:${orderId}` } },
        { name: 'stock.push', payload: { organizationId: org, connectionId: channelId }, options: { coalesceKey: `stock.push:${channelId}` } },
      ]),
    )
  })

  it('nothing is consumed twice: the statuses that follow, a return included, leave the Order and Stock alone', async () => {
    const { carrierSays, shipmentOf, order, available, count, statusChanges } = await setup()
    const parcel = await shipmentOf()
    await carrierSays(parcel, 'in_transit')
    const shipped = await order()

    for (const status of ['awaiting_pickup', 'delivery_problem', 'in_transit', 'returned'] as const) {
      await carrierSays(parcel, status)
      expect(await available()).toEqual({ stock: 8, reserved: 0, available: 8 })
    }

    expect(await count('stock.consumed')).toBe(1)
    expect(await statusChanges()).toHaveLength(1)
    const after = await order()
    expect(after).toMatchObject({ phase: 'shipped', statusId: shipped.statusId, statusPushSeq: 1, attentionReasons: [] })
    expect(after.closedAt).toEqual(shipped.closedAt)
  })

  it('a ready Shipment ships nothing: a printed Label is not a parcel the Carrier has', async () => {
    const { carrierSays, shipmentOf, order, available, shipment } = await setup()
    const parcel = await shipmentOf()
    await carrierSays(parcel, 'ready')
    expect(await order()).toMatchObject({ phase: 'new', closedAt: null, statusPushSeq: 0 })
    expect(await available()).toEqual({ stock: 10, reserved: 2, available: 8 })
    expect((await shipment(parcel.shipmentId)).handedOverAt).toBeNull()
  })

  it.each(['awaiting_pickup', 'delivery_problem', 'delivered', 'returned'] as const)('ships when the first status seen with the Carrier is %s', async (status) => {
    const { carrierSays, shipmentOf, order, available } = await setup()
    await carrierSays(await shipmentOf(), status)
    expect(await order()).toMatchObject({ phase: 'shipped' })
    expect(await available()).toEqual({ stock: 8, reserved: 0, available: 8 })
  })

  it('ships a processing Order too', async () => {
    const { ctx, org, orderId, carrierSays, shipmentOf, order, statusChanges } = await setup()
    await changeOrderStatus(ctx, org, orderId, 'processing', user)
    await carrierSays(await shipmentOf(), 'in_transit')
    expect(await order()).toMatchObject({ phase: 'shipped', statusPushSeq: 2 })
    expect((await statusChanges()).map((change) => [(change as { from: string }).from, (change as { cause: string }).cause])).toEqual([
      ['new', 'user'],
      ['processing', 'shipment'],
    ])
  })

  it('an Order a person already shipped is untouched, also when it sits in another status of that phase', async () => {
    const { ctx, org, orderId, carrierSays, shipmentOf, order, available, count, statusChanges } = await setup()
    const parcel = await shipmentOf()
    const admin = await addMember(ctx, org, 'owner')
    const { statusId: sentAbroad } = await createOrderStatus(ctx, org, { phase: 'shipped', name: 'Sent abroad', color: null }, admin)
    await changeOrderStatus(ctx, org, orderId, { statusId: sentAbroad }, user)
    const before = await order()
    ctx.queue.waiting.length = 0

    await carrierSays(parcel, 'in_transit')

    const after = await order()
    expect(after).toMatchObject({ phase: 'shipped', statusId: sentAbroad, statusPushSeq: before.statusPushSeq, attentionReasons: [] })
    expect(after.closedAt).toEqual(before.closedAt)
    expect(after.statusPushDueAt).toEqual(before.statusPushDueAt)
    expect(await available()).toEqual({ stock: 8, reserved: 0, available: 8 })
    expect(await count('stock.consumed')).toBe(1)
    expect(await statusChanges()).toHaveLength(1)
    expect(await count('order.attention_raised')).toBe(0)
    expect(ctx.queue.waiting.filter((job) => job.name !== 'shipments.track')).toEqual([])
  })

  it('an Order the Channel shipped is untouched as well', async () => {
    const { ctx, org, channelId, carrierSays, shipmentOf, order, available, count } = await setup()
    const parcel = await shipmentOf()
    const { externalId } = await order()
    await importOrder(ctx, org, channelId, buildOrder({ externalId, lines: [orderLine('l1', { sku: 'P', quantity: 2 })], facts: [fact('shipped-1', 'shipped')] }))
    await carrierSays(parcel, 'in_transit')
    expect(await order()).toMatchObject({ phase: 'shipped', attentionReasons: [] })
    expect(await available()).toEqual({ stock: 8, reserved: 0, available: 8 })
    expect(await count('stock.consumed')).toBe(1)
  })

  describe('an Order that cannot ship is left alone and marked shipment_conflict', () => {
    it('a cancelled Order: its released Stock stays released', async () => {
      const { ctx, org, orderId, carrierSays, shipmentOf, order, available, count, statusChanges } = await setup()
      const parcel = await shipmentOf()
      await changeOrderStatus(ctx, org, orderId, 'cancelled', user)
      const cancelled = await order()
      expect(await available()).toEqual({ stock: 10, reserved: 0, available: 10 })

      await carrierSays(parcel, 'in_transit')

      const after = await order()
      expect(after).toMatchObject({ phase: 'cancelled', statusId: cancelled.statusId, attentionReasons: ['shipment_conflict'], statusPushSeq: cancelled.statusPushSeq })
      expect(after.closedAt).toEqual(cancelled.closedAt)
      expect(after.lines.map((line) => line.reservation?.status)).toEqual(['released'])
      expect(await available()).toEqual({ stock: 10, reserved: 0, available: 10 })
      expect(await count('stock.consumed')).toBe(0)
      expect(await statusChanges()).toHaveLength(1)
      const raised = await ctx.db.eventLog.findFirstOrThrow({ where: { organizationId: org, type: 'order.attention_raised' } })
      expect(raised).toMatchObject({ subjectId: orderId, payload: { reasons: ['shipment_conflict'], shipmentId: parcel.shipmentId } })

      // A person settles it like any other reason that is not automatic.
      await resolveAttention(ctx, org, orderId, user)
      expect(await order()).toMatchObject({ phase: 'cancelled', attentionReasons: [] })
    })

    it('an Order with an Unmatched line: its matched line stays reserved until a person ships it', async () => {
      const { ctx, org, orderId, productId, carrierSays, shipmentOf, order, available, count } = await setup({
        lines: [orderLine('l1', { sku: 'P', quantity: 2 }), orderLine('l2', { sku: 'UNKNOWN', quantity: 1 })],
      })
      const parcel = await shipmentOf()

      await carrierSays(parcel, 'in_transit')

      const after = await order()
      expect(after).toMatchObject({ phase: 'new', closedAt: null, statusPushSeq: 0, attentionReasons: ['unmatched_line', 'shipment_conflict'] })
      expect(await available()).toEqual({ stock: 10, reserved: 2, available: 8 })
      expect(await count('stock.consumed')).toBe(0)
      expect(await count('order.status_changed')).toBe(0)

      // The person fixes the cause and ships the Order by hand: consumed once, the conflict still theirs to clear.
      const unmatched = after.lines.find((line) => line.productId === null)!
      await linkOrderLine(ctx, org, unmatched.id, productId, user)
      await changeOrderStatus(ctx, org, orderId, 'shipped', user)
      expect(await available()).toEqual({ stock: 7, reserved: 0, available: 7 })
      expect(await order()).toMatchObject({ phase: 'shipped', attentionReasons: ['shipment_conflict'] })
      await carrierSays(parcel, 'delivered')
      expect(await available()).toEqual({ stock: 7, reserved: 0, available: 7 })
    })

    it('an Order awaiting payment', async () => {
      const { ctx, org, orderId, carrierId, order, available, count } = await setup({ awaitingPayment: true })
      // `requestShipment` refuses such an Order, so this row stands for a Shipment made before the rule, or by hand.
      const row = await ctx.db.shipment.create({
        data: { organizationId: org, orderId, connectionId: carrierId, status: 'ready', service: 'test_locker', parcel: { preset: 'small' }, externalId: `unpaid-${orderId}`, nextCheckAt: new Date(Date.now() - 1_000) },
      })
      carrier.shipments.set(row.externalId!, { externalId: row.externalId!, reference: row.id, status: 'in_transit', trackingNumber: null, carrierStatus: null })

      await shipmentsTrackJob.handler(ctx, { organizationId: org, connectionId: carrierId }, jobRun)

      expect(await order()).toMatchObject({ phase: 'new', awaitingPayment: true, closedAt: null, attentionReasons: ['shipment_conflict'] })
      expect(await available()).toEqual({ stock: 10, reserved: 2, available: 8 })
      expect(await count('stock.consumed')).toBe(0)
      expect((await ctx.db.shipment.findFirstOrThrow({ where: { id: row.id } })).handedOverAt).not.toBeNull()
      carrier.shipments.delete(row.externalId!)
    })

    it('is raised once per Order, however many of its parcels the Carrier takes', async () => {
      const { ctx, org, orderId, carrierSays, shipmentOf, order, count } = await setup()
      const first = await shipmentOf()
      const second = await shipmentOf()
      await changeOrderStatus(ctx, org, orderId, 'cancelled', user)
      await carrierSays(first, 'in_transit')
      await carrierSays(second, 'in_transit')
      expect(await order()).toMatchObject({ attentionReasons: ['shipment_conflict'] })
      expect(await count('order.attention_raised')).toBe(1)
    })
  })

  it('two Shipments of one Order ship it once: the first parcel ships the whole Order', async () => {
    const { carrierSays, shipmentOf, order, available, count, statusChanges, shipment } = await setup()
    const first = await shipmentOf()
    const second = await shipmentOf()

    await carrierSays(first, 'in_transit')
    await carrierSays(second, 'in_transit')

    expect(await order()).toMatchObject({ phase: 'shipped', statusPushSeq: 1, attentionReasons: [] })
    expect(await available()).toEqual({ stock: 8, reserved: 0, available: 8 })
    expect(await count('stock.consumed')).toBe(1)
    expect(await statusChanges()).toMatchObject([{ shipmentId: first.shipmentId }])
    expect((await shipment(second.shipmentId)).handedOverAt).not.toBeNull()
  })

  it('two Shipments of one Order taken in the same track run ship it once', async () => {
    const { ctx, org, carrierId, shipmentOf, order, available, count } = await setup()
    const parcels = [await shipmentOf(), await shipmentOf(), await shipmentOf()]
    for (const parcel of parcels) carrier.advance(parcel.externalId, 'in_transit')
    await ctx.db.$executeRaw`UPDATE "shipment" SET "nextCheckAt" = now() - interval '1 second' WHERE "organizationId" = ${org}`
    await shipmentsTrackJob.handler(ctx, { organizationId: org, connectionId: carrierId }, jobRun)
    expect(await order()).toMatchObject({ phase: 'shipped', statusPushSeq: 1 })
    expect(await available()).toEqual({ stock: 8, reserved: 0, available: 8 })
    expect(await count('stock.consumed')).toBe(1)
    expect(await count('order.status_changed')).toBe(1)
  })

  it('an answer to the request that already has the parcel with the Carrier ships the Order from the create job', async () => {
    const { ctx, org, orderId, carrierId, order, available, shipment } = await setup()
    const { shipmentId } = await requestShipment(ctx, org, orderId, lockerShipment(carrierId), user)
    carrier.loseAnswers = 1
    await expect(shipmentsCreateJob.handler(ctx, { organizationId: org, shipmentId }, jobRun)).rejects.toThrow()
    // Hanza was down for a while; the Carrier took the parcel meanwhile. The repeat returns the Shipment as it is now.
    carrier.advance(carrier.byReference(shipmentId)!.externalId, 'in_transit')

    await shipmentsCreateJob.handler(ctx, { organizationId: org, shipmentId }, jobRun)

    expect(await shipment(shipmentId)).toMatchObject({ status: 'in_transit', createAttempts: 2 })
    expect((await shipment(shipmentId)).handedOverAt).not.toBeNull()
    expect(await order()).toMatchObject({ phase: 'shipped' })
    expect(await available()).toEqual({ stock: 8, reserved: 0, available: 8 })
  })

  describe('against a person shipping the Order at the same moment', () => {
    /**
     * Both writers are made to wait for the Order lock a third session holds, so they provably contend for it, then
     * run one after the other in whichever order Postgres wakes them.
     */
    async function race(first: 'person' | 'pickup') {
      const { ctx, org, orderId, carrierId, shipmentOf, order, available, count, statusChanges, shipment } = await setup()
      const parcel = await shipmentOf()
      carrier.advance(parcel.externalId, 'in_transit')
      await ctx.db.$executeRaw`UPDATE "shipment" SET "nextCheckAt" = now() - interval '1 second' WHERE "id" = ${parcel.shipmentId}`
      const person = () => changeOrderStatus(ctx, org, orderId, 'shipped', user)
      const pickup = () => shipmentsTrackJob.handler(ctx, { organizationId: org, connectionId: carrierId }, jobRun)

      const holder: Db = createDb(databaseUrl!)
      let release!: () => void
      const released = new Promise<void>((resolve) => (release = resolve))
      let locked!: () => void
      const isLocked = new Promise<void>((resolve) => (locked = resolve))
      const holding = holder.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "order" WHERE "id" = ${orderId} FOR NO KEY UPDATE`
        locked()
        await released
      }, TX_OPTIONS)
      await isLocked

      const waitFor = async (sessions: number) => {
        const deadline = Date.now() + 5_000
        while ((await countLockWaits(holder, applicationName)) < sessions) {
          if (Date.now() > deadline) throw new Error(`${sessions} sessions did not wait for the Order lock`)
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
      // The first one queues for the lock before the second starts, so Postgres grants it first.
      const racers = first === 'person' ? [person, pickup] : [pickup, person]
      const running = [racers[0]!()]
      await waitFor(1)
      running.push(racers[1]!())
      await waitFor(2)
      release()
      await holding
      await holder.$disconnect()
      const settled = await Promise.allSettled(running)
      const [personResult] = first === 'person' ? settled : [settled[1]]
      const [pickupResult] = first === 'person' ? [settled[1]] : settled

      // Neither deadlocked, and whoever came second found the Order shipped.
      expect(pickupResult!.status).toBe('fulfilled')
      const shipped = await order()
      expect(shipped).toMatchObject({ phase: 'shipped', statusPushSeq: 1, attentionReasons: [] })
      expect(shipped.lines.map((line) => line.reservation?.status)).toEqual(['consumed'])
      expect(await available()).toEqual({ stock: 8, reserved: 0, available: 8 })
      expect(await count('stock.consumed')).toBe(1)
      expect(await statusChanges()).toHaveLength(1)
      expect((await shipment(parcel.shipmentId)).handedOverAt).not.toBeNull()
      return { personResult: personResult!, cause: ((await statusChanges())[0] as { cause: string }).cause }
    }

    it('the person first: the pickup finds the Order shipped and changes nothing', async () => {
      const { personResult, cause } = await race('person')
      expect(personResult.status).toBe('fulfilled')
      expect(cause).toBe('user')
    })

    it('the pickup first: the person is told the Order is shipped already, and nothing is consumed again', async () => {
      const { personResult, cause } = await race('pickup')
      expect(personResult).toMatchObject({ status: 'rejected', reason: { code: 'invalid_transition' } })
      expect(cause).toBe('shipment')
    })

    it('twenty Orders, each shipped by a person and by its pickup at once: every one consumed exactly once', async () => {
      const { ctx, org, channelId, carrierId, productId, available } = await setup()
      const orderIds: string[] = []
      for (let i = 0; i < 20; i++) {
        const { orderId } = await importOrder(ctx, org, channelId, buildOrder({ lines: [orderLine('l1', { sku: 'P', quantity: 1 })] }))
        const { shipmentId } = await requestShipment(ctx, org, orderId, lockerShipment(carrierId), user)
        await shipmentsCreateJob.handler(ctx, { organizationId: org, shipmentId }, jobRun)
        carrier.advance(carrier.byReference(shipmentId)!.externalId, 'in_transit')
        orderIds.push(orderId)
      }
      await ctx.db.$executeRaw`UPDATE "shipment" SET "nextCheckAt" = now() - interval '1 second' WHERE "organizationId" = ${org} AND "externalId" IS NOT NULL`

      const settled = await Promise.allSettled([
        shipmentsTrackJob.handler(ctx, { organizationId: org, connectionId: carrierId }, jobRun),
        ...orderIds.map((orderId) => changeOrderStatus(ctx, org, orderId, 'shipped', user)),
      ])

      expect(settled[0]!.status).toBe('fulfilled')
      for (const result of settled.slice(1)) {
        if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'invalid_transition' })
      }
      expect(await ctx.db.order.count({ where: { organizationId: org, id: { in: orderIds }, phase: 'shipped' } })).toBe(20)
      expect(await ctx.db.reservation.count({ where: { organizationId: org, status: 'consumed' } })).toBe(20)
      expect(await ctx.db.eventLog.count({ where: { organizationId: org, type: 'stock.consumed' } })).toBe(20)
      expect(await ctx.db.eventLog.count({ where: { organizationId: org, type: 'order.status_changed' } })).toBe(20)
      // 10 on the shelf, 2 still reserved by the first Order, 20 gone.
      expect(await available()).toEqual({ stock: -10, reserved: 2, available: -12 })
      expect((await ctx.db.stock.findFirstOrThrow({ where: { organizationId: org, productId } })).units).toBe(-10)
    })
  })
})
