import { createFakeChannel, type FakeChannel } from '@hanza/connector-fake'
import {
  addConnection,
  changeOrderStatus,
  coalesceKeys,
  createProduct,
  getAvailability,
  getOrder,
  jobs,
  listOrders,
  ordersPullRef,
  type Actor,
} from '@hanza/core'
import { createTestContext, createTestOrganization, type TestContext } from '@hanza/core/testing'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

const databaseUrl = inject('hanzaTestDatabaseUrl')
const user: Actor = { type: 'user', userId: 'user-1' }

type ChannelOrder = Parameters<FakeChannel['addOrder']>[0]
type ChannelLine = ChannelOrder['lines'][number]

const pln = (amount: string) => ({ amount, currency: 'PLN' })
const toteLine = (externalId: string, quantity: number): ChannelLine => ({
  externalId,
  offerExternalId: 'fake-offer-5',
  sku: 'FAKE-SKU-5',
  name: 'Linen tote bag',
  quantity,
  unitPrice: pln('30.00'),
})

const paidFact = (orderExternalId: string, occurredAt = '2026-10-04T10:00:00Z') => ({
  id: `${orderExternalId}:paid`,
  type: 'paid' as const,
  occurredAt,
  note: null,
})

function unpaidOrder(externalId: string, lines: ChannelLine[]): ChannelOrder {
  return {
    externalId,
    placedAt: '2026-10-04T09:00:00Z',
    payment: 'prepaid',
    awaitingPayment: true,
    total: pln('30.00'),
    buyer: { name: 'Jane Unpaid', email: null, phone: null, login: 'jane_unpaid' },
    shippingAddress: {
      name: 'Jane Unpaid',
      company: null,
      street: '2 Example Street',
      postalCode: '00-002',
      city: 'Warsaw',
      countryCode: 'PL',
      phone: null,
      taxId: null,
    },
    billingAddress: null,
    lines,
    facts: [],
  }
}

describe.skipIf(!databaseUrl)('Orders awaiting payment end to end (real Postgres, in-memory queue, fake Channel)', () => {
  let ctx: TestContext
  let fake: FakeChannel
  let org: string
  let connectionId: string
  let tote: string

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
  }

  async function pullOrders() {
    await ctx.queue.enqueue(
      ordersPullRef,
      { organizationId: org, connectionId, trigger: 'schedule' },
      { coalesceKey: coalesceKeys.ordersPull(connectionId) },
    )
    await drain()
  }

  function lastPushedTote(): number | undefined {
    for (const levels of [...fake.stockPushes].reverse()) {
      const level = levels.find((candidate) => candidate.offerExternalId === 'fake-offer-5')
      if (level) return level.available
    }
    return undefined
  }

  const available = async () => (await getAvailability(ctx.db, org, [tote])).get(tote)!

  function order(externalId: string) {
    return ctx.db.order.findFirstOrThrow({
      where: { organizationId: org, connectionId, externalId },
      include: { lines: { orderBy: { externalId: 'asc' }, include: { reservation: true } } },
    })
  }

  async function eventTypes(orderId: string) {
    const events = await ctx.db.eventLog.findMany({ where: { organizationId: org, subjectId: orderId }, orderBy: { id: 'asc' } })
    return events.map((event) => event.type)
  }

  const counts = async () => ({
    orders: await ctx.db.order.count({ where: { organizationId: org } }),
    reservations: await ctx.db.reservation.count({ where: { organizationId: org } }),
    facts: await ctx.db.orderChannelFact.count({ where: { organizationId: org } }),
    events: await ctx.db.eventLog.count({ where: { organizationId: org } }),
  })

  it('1. syncs a Channel whose tote bag Offer is linked to a Product with 3 units', async () => {
    tote = (await createProduct(ctx, org, { sku: 'FAKE-SKU-5', name: 'Linen tote bag', stock: 3 }, user)).productId
    connectionId = (
      await addConnection(ctx, org, { connectorId: 'fake', name: 'Test channel', config: { failMode: 'none' }, credentials: { apiKey: 'test' } }, user)
    ).connectionId
    await drain()
    expect(lastPushedTote()).toBe(3)
  })

  it('2. imports an unpaid Order: listed, marked, not fulfillable, and its Reservation lowers the Available pushed', async () => {
    fake.addOrder(unpaidOrder('unpaid-1', [toteLine('l1', 2)]))
    await pullOrders()

    const unpaid = await order('unpaid-1')
    expect(unpaid).toMatchObject({ status: 'new', awaitingPayment: true, attentionReasons: [] })
    expect(unpaid.lines.map((line) => [line.productId, line.reservation?.status, line.reservation?.units])).toEqual([[tote, 'open', 2]])
    expect(await available()).toEqual({ stock: 3, reserved: 2, available: 1 })
    expect(lastPushedTote()).toBe(1)

    const listed = await listOrders(ctx, org, { awaitingPayment: true, skip: 0, take: 50 })
    expect(listed.items.map((row) => [row.externalId, row.awaitingPayment])).toEqual([['unpaid-1', true]])
    expect(await getOrder(ctx, org, unpaid.id)).toMatchObject({ awaitingPayment: true, allowedTransitions: ['cancelled'] })

    for (const to of ['processing', 'shipped'] as const) {
      await expect(changeOrderStatus(ctx, org, unpaid.id, to, user)).rejects.toMatchObject({ code: 'awaiting_payment' })
    }
    expect((await order('unpaid-1')).status).toBe('new')
  })

  it('3. the payment reported by the Channel makes it a ready Order exactly once, with no second Reservation', async () => {
    const pushesBefore = fake.stockPushes.length
    fake.addFact('unpaid-1', paidFact('unpaid-1'))
    await pullOrders()

    const paid = await order('unpaid-1')
    expect(paid).toMatchObject({ status: 'new', awaitingPayment: false, attentionReasons: [] })
    expect(await ctx.db.reservation.count({ where: { organizationId: org, orderLine: { orderId: paid.id } } })).toBe(1)
    expect(await available()).toEqual({ stock: 3, reserved: 2, available: 1 })
    // Available did not change, so nothing is pushed again.
    expect(fake.stockPushes).toHaveLength(pushesBefore)
    expect(await eventTypes(paid.id)).toEqual(['order.imported', 'order.channel_fact_recorded', 'order.payment_received'])
    expect((await listOrders(ctx, org, { awaitingPayment: true, skip: 0, take: 50 })).total).toBe(0)

    // The Channel returning the same Order and facts again changes nothing.
    const before = await counts()
    fake.addOrder({ ...unpaidOrder('unpaid-1', [toteLine('l1', 2)]), awaitingPayment: false, facts: [paidFact('unpaid-1')] })
    await pullOrders()
    expect(await counts()).toEqual(before)
    expect(fake.stockPushes).toHaveLength(pushesBefore)

    // From now on it is an ordinary Order: a person can fulfil it.
    await changeOrderStatus(ctx, org, paid.id, 'processing', user)
    await changeOrderStatus(ctx, org, paid.id, 'shipped', user)
    await drain()
    expect(await available()).toEqual({ stock: 1, reserved: 0, available: 1 })
    expect(fake.statusUpdates).toContainEqual({ orderExternalId: 'unpaid-1', status: 'shipped' })
  })

  it('4. a Channel cancelling an unpaid Order releases its Reservation and restores Available', async () => {
    fake.addOrder(unpaidOrder('unpaid-2', [toteLine('l1', 1)]))
    await pullOrders()
    expect(lastPushedTote()).toBe(0)

    fake.addFact('unpaid-2', { id: 'unpaid-2:cancelled', type: 'cancelled', occurredAt: '2026-10-05T09:00:00Z', note: 'Not paid in time' })
    await pullOrders()

    const cancelled = await order('unpaid-2')
    expect(cancelled).toMatchObject({ status: 'cancelled', awaitingPayment: true, attentionReasons: [] })
    expect(cancelled.lines[0]?.reservation?.status).toBe('released')
    expect(await available()).toEqual({ stock: 1, reserved: 0, available: 1 })
    expect(lastPushedTote()).toBe(1)
    // An abandoned checkout is not waiting for anything: the "awaiting payment" filter leaves it out.
    expect((await listOrders(ctx, org, { awaitingPayment: true, skip: 0, take: 50 })).total).toBe(0)
    // A Channel fact is never pushed back to the Channel.
    expect(fake.statusUpdates).not.toContainEqual(expect.objectContaining({ orderExternalId: 'unpaid-2' }))
  })

  it('5. an unpaid Order with an Unmatched line and a Shortage is marked like any Order and stays so once paid', async () => {
    fake.addOrder(
      unpaidOrder('unpaid-3', [
        toteLine('l1', 5),
        { externalId: 'l2', offerExternalId: null, sku: 'NOT-IN-CATALOGUE', name: 'Gift wrap', quantity: 1, unitPrice: pln('5.00') },
      ]),
    )
    await pullOrders()

    const unpaid = await order('unpaid-3')
    expect(unpaid).toMatchObject({ status: 'new', awaitingPayment: true, attentionReasons: ['unmatched_line', 'shortage'] })
    expect(unpaid.lines.map((line) => [line.externalId, line.shortage, line.reservation?.status ?? null])).toEqual([
      ['l1', true, 'open'],
      ['l2', false, null],
    ])
    expect(await available()).toEqual({ stock: 1, reserved: 5, available: -4 })
    expect(lastPushedTote()).toBe(0)

    fake.addFact('unpaid-3', paidFact('unpaid-3', '2026-10-05T10:00:00Z'))
    await pullOrders()
    expect(await order('unpaid-3')).toMatchObject({ awaitingPayment: false, attentionReasons: ['unmatched_line', 'shortage'] })
    expect(await ctx.db.reservation.count({ where: { organizationId: org, orderLine: { orderId: unpaid.id } } })).toBe(1)
    expect(await available()).toEqual({ stock: 1, reserved: 5, available: -4 })
  })

  it('6. pulling again changes nothing', async () => {
    const before = await counts()
    const pushesBefore = fake.stockPushes.length
    await pullOrders()
    expect(await counts()).toEqual(before)
    expect(fake.stockPushes).toHaveLength(pushesBefore)
  })
})
