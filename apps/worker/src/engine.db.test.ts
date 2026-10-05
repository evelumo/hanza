import { createFakeChannel, type FakeChannel } from '@hanza/connector-fake'
import {
  addConnection,
  changeOrderStatus,
  coalesceKeys,
  createProduct,
  getAvailability,
  jobs,
  linkOffer,
  MAX_RATE_LIMIT_RETRIES,
  ordersPullRef,
  PermanentJobError,
  requestSync,
  syncTickRef,
  type Actor,
} from '@hanza/core'
import { createTestContext, createTestOrganization, type TestContext } from '@hanza/core/testing'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

const databaseUrl = inject('hanzaTestDatabaseUrl')
const user: Actor = { type: 'user', userId: 'user-1' }

describe.skipIf(!databaseUrl)('sync engine end to end (real Postgres, in-memory queue, fake Channel)', () => {
  let ctx: TestContext
  let fake: FakeChannel
  let org: string
  let connectionId: string
  const products: Record<string, string> = {}

  beforeAll(async () => {
    fake = createFakeChannel()
    ctx = createTestContext({ databaseUrl: databaseUrl!, connectors: [fake.connector] })
    org = await createTestOrganization(ctx.db)
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

  function lastPushed(offerExternalId: string): number | undefined {
    for (const levels of [...fake.stockPushes].reverse()) {
      const level = levels.find((candidate) => candidate.offerExternalId === offerExternalId)
      if (level) return level.available
    }
    return undefined
  }

  function order(externalId: string) {
    return ctx.db.order.findFirstOrThrow({
      where: { organizationId: org, connectionId, externalId },
      include: { lines: { orderBy: { externalId: 'asc' }, include: { reservation: true } } },
    })
  }

  async function health(id: string) {
    return (await ctx.db.connection.findFirstOrThrow({ where: { id, organizationId: org } })).health
  }

  async function syncState(id: string, stream: 'offers_pull' | 'orders_pull' | 'stock_push' | 'order_status_push') {
    return ctx.db.syncState.findFirst({ where: { organizationId: org, connectionId: id, stream } })
  }

  async function pullOrders() {
    await ctx.queue.enqueue(
      ordersPullRef,
      { organizationId: org, connectionId, trigger: 'schedule' },
      { coalesceKey: coalesceKeys.ordersPull(connectionId) },
    )
    await drain()
  }

  it('1. creates Products and a fake Connection, then syncs it', async () => {
    for (const [sku, stock] of [['FAKE-SKU-1', 5], ['FAKE-SKU-2', 1], ['FAKE-SKU-3', 0]] as const) {
      products[sku] = (await createProduct(ctx, org, { sku, name: sku, stock }, user)).productId
    }
    connectionId = (
      await addConnection(ctx, org, { connectorId: 'fake', name: 'Test channel', config: { failMode: 'none' }, credentials: { apiKey: 'test' } }, user)
    ).connectionId
    const { ran } = await drain()
    expect(ran).toBeGreaterThanOrEqual(3)
    expect(await health(connectionId)).toBe('ok')
  })

  it('2. pulls Offers (1-3 linked by SKU) and imports Orders with Reservations, a Shortage and Unmatched lines', async () => {
    const offers = await ctx.db.offer.findMany({ where: { organizationId: org, connectionId }, orderBy: { externalId: 'asc' } })
    expect(offers.map((offer) => [offer.externalId, offer.productId, offer.linkedBy])).toEqual([
      ['fake-offer-1', products['FAKE-SKU-1'], 'sku'],
      ['fake-offer-2', products['FAKE-SKU-2'], 'sku'],
      ['fake-offer-3', products['FAKE-SKU-3'], 'sku'],
      ['fake-offer-4', null, null],
      ['fake-offer-5', null, null],
    ])
    expect(await ctx.db.order.count({ where: { organizationId: org } })).toBe(4)

    const first = await order('fake-order-1')
    expect(first.status).toBe('new')
    expect(first.attentionReasons).toEqual([])
    expect(first.lines.map((line) => [line.reservation?.status, line.reservation?.units])).toEqual([['open', 2]])

    const second = await order('fake-order-2')
    expect(second.status).toBe('cancelled')
    expect(second.attentionReasons).toEqual([])
    expect(second.lines.map((line) => [line.sku, line.shortage, line.reservation?.status])).toEqual([
      ['FAKE-SKU-2', false, 'released'],
      ['FAKE-SKU-3', true, 'released'],
    ])

    for (const externalId of ['fake-order-3', 'fake-order-4']) {
      const unmatched = await order(externalId)
      expect(unmatched.attentionReasons).toEqual(['unmatched_line'])
      expect(unmatched.lines.every((line) => line.productId === null && line.reservation === null)).toBe(true)
    }

    expect(await syncState(connectionId, 'offers_pull')).toMatchObject({ lastResult: { seen: 5, created: 5, updated: 0, linked: 3 } })
    expect(await syncState(connectionId, 'orders_pull')).toMatchObject({
      cursor: '5',
      lastResult: { pulled: 5, imported: 4, factsApplied: 1, pages: 3 },
    })
  })

  it('3. pushes Available to the fake Channel', async () => {
    expect([lastPushed('fake-offer-1'), lastPushed('fake-offer-2'), lastPushed('fake-offer-3')]).toEqual([3, 1, 0])
    expect(lastPushed('fake-offer-4')).toBeUndefined()
    const offers = await ctx.db.offer.findMany({ where: { organizationId: org, connectionId, productId: { not: null } } })
    expect(offers.every((offer) => offer.stockPushedSeq === offer.stockPushSeq)).toBe(true)
  })

  it('4. linking an Offer by hand links the waiting Order line and pushes the new Product', async () => {
    products.STICKERS = (await createProduct(ctx, org, { sku: 'STICKERS', name: 'Stickers', stock: 10 }, user)).productId
    const offer4 = await ctx.db.offer.findFirstOrThrow({ where: { organizationId: org, connectionId, externalId: 'fake-offer-4' } })
    await linkOffer(ctx, org, offer4.id, products.STICKERS, user)
    await drain()

    const fourth = await order('fake-order-4')
    expect(fourth.attentionReasons).toEqual([])
    expect(fourth.lines.map((line) => [line.productId, line.reservation?.status, line.reservation?.units])).toEqual([
      [products.STICKERS, 'open', 3],
    ])
    expect(lastPushed('fake-offer-4')).toBe(7)
  })

  it('5. shipping an Order consumes its Reservation and pushes the status to the Channel', async () => {
    const first = await order('fake-order-1')
    await changeOrderStatus(ctx, org, first.id, 'shipped', user)
    await drain()

    const availability = (await getAvailability(ctx.db, org, [products['FAKE-SKU-1']!])).get(products['FAKE-SKU-1']!)
    expect(availability).toEqual({ stock: 3, reserved: 0, available: 3 })
    expect(fake.statusUpdates).toContainEqual({ orderExternalId: 'fake-order-1', status: 'shipped' })
    // The fake keeps its data in memory and sends no request, so the run only records that it finished.
    expect(await syncState(connectionId, 'order_status_push')).toMatchObject({ lastResult: null, lastErrorKind: null })
    expect((await syncState(connectionId, 'order_status_push'))?.lastFinishedAt).not.toBeNull()
    expect(lastPushed('fake-offer-1')).toBe(3)
  })

  it('6. a cancellation reported by the Channel releases the Reservation and pushes the Stock back', async () => {
    fake.addFact('fake-order-4', { id: 'fake-order-4:cancelled', type: 'cancelled', occurredAt: '2026-10-03T10:00:00Z', note: null })
    await pullOrders()

    const fourth = await order('fake-order-4')
    expect(fourth.status).toBe('cancelled')
    expect(fourth.lines[0]?.reservation?.status).toBe('released')
    expect(lastPushed('fake-offer-4')).toBe(10)
    // A Channel fact is never pushed back to the Channel.
    expect(fake.statusUpdates).not.toContainEqual(expect.objectContaining({ orderExternalId: 'fake-order-4' }))
  })

  it('7. pulling again changes nothing', async () => {
    const counts = async () => ({
      orders: await ctx.db.order.count({ where: { organizationId: org } }),
      lines: await ctx.db.orderLine.count({ where: { organizationId: org } }),
      reservations: await ctx.db.reservation.count({ where: { organizationId: org } }),
      facts: await ctx.db.orderChannelFact.count({ where: { organizationId: org } }),
      events: await ctx.db.eventLog.count({ where: { organizationId: org } }),
    })
    const before = await counts()
    const pushesBefore = fake.stockPushes.length
    await pullOrders()
    expect(await counts()).toEqual(before)
    expect(fake.stockPushes).toHaveLength(pushesBefore)
    expect(await syncState(connectionId, 'orders_pull')).toMatchObject({ cursor: '6', lastResult: { pulled: 0, imported: 0 } })
  })

  it('auth_expired: the run fails without retry, the Connection waits for sign-in and the tick skips it', async () => {
    const { connectionId: expired } = await addConnection(
      ctx,
      org,
      { connectorId: 'fake', name: 'Expired key', config: { failMode: 'none' }, credentials: { apiKey: 'expired' } },
      user,
    )
    const result = await ctx.queue.drain(ctx, jobs)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]).toMatchObject({ name: 'offers.pull', attempts: 1 })
    expect(result.failed[0]?.error).toBeInstanceOf(PermanentJobError)
    expect(await health(expired)).toBe('auth_expired')
    expect(await syncState(expired, 'offers_pull')).toMatchObject({ lastErrorKind: 'auth_expired', lastSucceededAt: null })
    const events = await ctx.db.eventLog.findMany({
      where: { organizationId: org, subjectType: 'connection', subjectId: expired, type: 'connection.health_changed' },
    })
    expect(events.map((event) => event.payload)).toEqual([{ from: 'unknown', to: 'auth_expired', errorKind: 'auth_expired' }])

    const before = ctx.queue.enqueued.length
    await ctx.queue.enqueue(syncTickRef, {})
    await ctx.queue.drain(ctx, jobs)
    const fromTick = ctx.queue.enqueued.slice(before + 1)
    expect(fromTick.filter((job) => (job.payload as { connectionId: string }).connectionId === expired)).toEqual([])

    // "Synchronise now" still runs it; with the key still expired, nothing turns it back to ok.
    await requestSync(ctx, org, expired)
    const manual = await ctx.queue.drain(ctx, jobs)
    expect(manual.failed.map((failure) => failure.name)).toEqual(['offers.pull'])
    expect(await health(expired)).toBe('auth_expired')
  })

  it('rate_limited: the run is retried later without using attempts and health stays unchanged', async () => {
    const { connectionId: limited } = await addConnection(
      ctx,
      org,
      { connectorId: 'fake', name: 'Rate limit', config: { failMode: 'rate_limited' }, credentials: { apiKey: 'test' } },
      user,
    )
    const result = await ctx.queue.drain(ctx, jobs, { maxJobs: 6 })
    expect(result).toEqual({ ran: 6, failed: [] })
    expect(ctx.queue.waiting.map((job) => [job.name, (job.payload as { connectionId: string }).connectionId])).toEqual([['offers.pull', limited]])
    expect(await health(limited)).toBe('unknown')
    expect(await syncState(limited, 'offers_pull')).toMatchObject({ lastErrorKind: 'rate_limited', lastSucceededAt: null })
    ctx.queue.waiting.length = 0
  })

  it('rate_limited for good: each attempt is retried later 10 times, then used; the job ends and the Connection is failing', async () => {
    const { connectionId: throttled } = await addConnection(
      ctx,
      org,
      { connectorId: 'fake', name: 'Permanent limit', config: { failMode: 'rate_limited' }, credentials: { apiKey: 'test' } },
      user,
    )
    const result = await ctx.queue.drain(ctx, jobs)
    expect(result.ran).toBe(5 * (MAX_RATE_LIMIT_RETRIES + 1))
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]).toMatchObject({ name: 'offers.pull', attempts: 5 })
    expect(ctx.queue.waiting).toEqual([])
    expect(await health(throttled)).toBe('failing')
    expect(await syncState(throttled, 'offers_pull')).toMatchObject({ lastErrorKind: 'transient', lastSucceededAt: null })
  })

  it('transient: retried up to 5 attempts, then the Connection is failing', async () => {
    const { connectionId: flaky } = await addConnection(
      ctx,
      org,
      { connectorId: 'fake', name: 'Flaky', config: { failMode: 'transient' }, credentials: { apiKey: 'test' } },
      user,
    )
    const result = await ctx.queue.drain(ctx, jobs)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]).toMatchObject({ name: 'offers.pull', attempts: 5 })
    expect(await health(flaky)).toBe('failing')
  })
})

const address = {
  name: 'John Test',
  company: null,
  street: '1 Example Street',
  postalCode: '00-001',
  city: 'Warsaw',
  countryCode: 'PL',
  phone: null,
  taxId: null,
}
const buyer = { name: 'John Test', email: 'john.test@example.com', phone: null, login: 'john_test' }

describe.skipIf(!databaseUrl)('a cancelled Order leaves Needs attention (real Postgres, in-memory queue, fake Channel)', () => {
  let ctx: TestContext
  let fake: FakeChannel
  let org: string
  let connectionId: string

  beforeAll(async () => {
    fake = createFakeChannel()
    ctx = createTestContext({ databaseUrl: databaseUrl!, connectors: [fake.connector] })
    org = await createTestOrganization(ctx.db)
  })

  afterAll(async () => {
    await ctx?.db.$disconnect()
  })

  const order = (externalId: string) =>
    ctx.db.order.findFirstOrThrow({ where: { organizationId: org, connectionId, externalId }, include: { lines: true } })

  const needsAttention = async () =>
    (
      await ctx.db.order.findMany({
        where: { organizationId: org, attentionReasons: { isEmpty: false } },
        select: { externalId: true },
        orderBy: { externalId: 'asc' },
      })
    ).map((row) => row.externalId)

  async function pullOrders() {
    await ctx.queue.enqueue(
      ordersPullRef,
      { organizationId: org, connectionId, trigger: 'schedule' },
      { coalesceKey: coalesceKeys.ordersPull(connectionId) },
    )
    const result = await ctx.queue.drain(ctx, jobs)
    expect(result.failed).toEqual([])
  }

  it('fake-order-2 with Unmatched lines: imported open, then cancelled by the Channel, it is no longer Needs attention', async () => {
    // No Product exists, so the lines of every Order are Unmatched (the smoke-test situation of issue #16).
    // The seed already carries the cancellation of fake-order-2; replace the Order with the same one without it.
    fake.addOrder({
      externalId: 'fake-order-2',
      placedAt: '2026-10-01T10:00:00Z',
      payment: 'cash_on_delivery',
      total: { amount: '84.00', currency: 'PLN' },
      buyer,
      shippingAddress: address,
      billingAddress: null,
      lines: [
        { externalId: 'l1', offerExternalId: 'fake-offer-2', sku: 'FAKE-SKU-2', name: 'Cotton T-shirt M', quantity: 1, unitPrice: { amount: '59.00', currency: 'PLN' } },
        { externalId: 'l2', offerExternalId: 'fake-offer-3', sku: 'FAKE-SKU-3', name: 'Poster A3', quantity: 1, unitPrice: { amount: '25.00', currency: 'PLN' } },
      ],
      facts: [],
    })
    connectionId = (
      await addConnection(ctx, org, { connectorId: 'fake', name: 'Test channel', config: { failMode: 'none' }, credentials: { apiKey: 'test' } }, user)
    ).connectionId
    expect((await ctx.queue.drain(ctx, jobs)).failed).toEqual([])

    const open = await order('fake-order-2')
    expect(open.status).toBe('new')
    expect(open.attentionReasons).toEqual(['unmatched_line'])
    expect(open.lines.every((line) => line.productId === null)).toBe(true)
    expect(await needsAttention()).toEqual(['fake-order-1', 'fake-order-2', 'fake-order-3', 'fake-order-4'])

    fake.addFact('fake-order-2', { id: 'fake-order-2:cancelled', type: 'cancelled', occurredAt: '2026-10-02T10:00:00Z', note: 'Cancelled by the buyer' })
    await pullOrders()

    const cancelled = await order('fake-order-2')
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.attentionReasons).toEqual([])
    // The lines are still Unmatched: only the Order-level mark is gone.
    expect(cancelled.lines.every((line) => line.productId === null)).toBe(true)
    expect(await needsAttention()).toEqual(['fake-order-1', 'fake-order-3', 'fake-order-4'])
    // A Channel fact is never pushed back to the Channel.
    expect(fake.statusUpdates).toEqual([])
  })

  it('an Order that arrives already cancelled with an Unmatched line is not Needs attention either', async () => {
    fake.addOrder({
      externalId: 'fake-order-5',
      placedAt: '2026-10-03T10:00:00Z',
      payment: 'prepaid',
      total: { amount: '10.00', currency: 'PLN' },
      buyer,
      shippingAddress: address,
      billingAddress: null,
      lines: [{ externalId: 'l1', offerExternalId: null, sku: 'UNKNOWN-SKU', name: 'Unknown', quantity: 1, unitPrice: { amount: '10.00', currency: 'PLN' } }],
      facts: [{ id: 'fake-order-5:cancelled', type: 'cancelled', occurredAt: '2026-10-03T11:00:00Z', note: null }],
    })
    await pullOrders()

    expect(await order('fake-order-5')).toMatchObject({ status: 'cancelled', attentionReasons: [] })
    expect(await needsAttention()).toEqual(['fake-order-1', 'fake-order-3', 'fake-order-4'])
  })
})
