import { describe, expect, it } from 'vitest'
import { createProduct } from '../catalog/products'
import { getAvailability } from '../stock/availability'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, createTestConnection, fact, orderLine, user } from '../testing/fixtures'
import { changeOrderStatus } from './change-status'
import { importOrder } from './import'
import { getOrder, listOrders } from './queries'

describe.skipIf(!databaseUrl)('Orders awaiting payment', () => {
  const context = useTestContext()

  async function setup(stock = 10) {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const connectionId = await createTestConnection(ctx, org)
    const { productId } = await createProduct(ctx, org, { sku: 'P', name: 'Product', stock }, user)
    const available = async () => (await getAvailability(ctx.db, org, [productId])).get(productId)!
    const stored = (orderId: string) =>
      ctx.db.order.findFirstOrThrow({ where: { id: orderId, organizationId: org }, include: { lines: { include: { reservation: true } } } })
    const events = async (orderId: string) =>
      (await ctx.db.eventLog.findMany({ where: { organizationId: org, subjectId: orderId }, orderBy: { id: 'asc' } })).map((event) => event.type)
    const counts = async () => ({
      reservations: await ctx.db.reservation.count({ where: { organizationId: org } }),
      facts: await ctx.db.orderChannelFact.count({ where: { organizationId: org } }),
      events: await ctx.db.eventLog.count({ where: { organizationId: org } }),
    })
    return { ctx, org, connectionId, productId, available, stored, events, counts }
  }

  const unpaid = (overrides: Parameters<typeof buildOrder>[0] = {}) =>
    buildOrder({ awaitingPayment: true, lines: [orderLine('l1', { sku: 'P', quantity: 2 })], ...overrides })
  const paidFact = (id = 'paid', occurredAt = '2026-10-02T12:00:00Z') => fact(id, 'paid', occurredAt)

  it('imports an unpaid Order marked awaiting payment, with a Reservation like any Order', async () => {
    const { ctx, org, connectionId, productId, available, stored } = await setup()
    const { orderId } = await importOrder(ctx, org, connectionId, unpaid())

    const order = await stored(orderId)
    expect(order).toMatchObject({ status: 'new', awaitingPayment: true, attentionReasons: [] })
    expect(order.lines[0]?.reservation).toMatchObject({ productId, units: 2, status: 'open' })
    expect(await available()).toEqual({ stock: 10, reserved: 2, available: 8 })
    const imported = await ctx.db.eventLog.findFirstOrThrow({ where: { subjectId: orderId, type: 'order.imported' } })
    expect(imported.payload).toMatchObject({ awaitingPayment: true })
  })

  it('a paid fact makes it ready once: flag cleared, one Event, no second Reservation, idempotent', async () => {
    const { ctx, org, connectionId, available, stored, events, counts } = await setup()
    const order = unpaid()
    const { orderId } = await importOrder(ctx, org, connectionId, order)
    const before = await counts()

    const paid = { ...order, awaitingPayment: false, facts: [paidFact()] }
    expect(await importOrder(ctx, org, connectionId, paid)).toMatchObject({ created: false, factsApplied: 1 })

    expect(await stored(orderId)).toMatchObject({ status: 'new', awaitingPayment: false, attentionReasons: [] })
    expect(await available()).toEqual({ stock: 10, reserved: 2, available: 8 })
    expect(await counts()).toEqual({ ...before, facts: before.facts + 1, events: before.events + 2 })
    expect(await events(orderId)).toEqual(['order.imported', 'order.channel_fact_recorded', 'order.payment_received'])
    const received = await ctx.db.eventLog.findFirstOrThrow({ where: { subjectId: orderId, type: 'order.payment_received' } })
    expect(received.payload).toEqual({ factId: 'paid' })

    const settled = await counts()
    expect(await importOrder(ctx, org, connectionId, paid)).toMatchObject({ factsApplied: 0 })
    expect(await counts()).toEqual(settled)

    // From now on it is an ordinary ready Order.
    await changeOrderStatus(ctx, org, orderId, 'shipped', user)
    expect(await available()).toEqual({ stock: 8, reserved: 0, available: 8 })
  })

  it('a later snapshot that only drops the flag, without a paid fact, changes nothing (ADR 0003)', async () => {
    const { ctx, org, connectionId, stored } = await setup()
    const order = unpaid()
    const { orderId } = await importOrder(ctx, org, connectionId, order)
    await importOrder(ctx, org, connectionId, { ...order, awaitingPayment: false })
    expect((await stored(orderId)).awaitingPayment).toBe(true)
  })

  it('an Order first seen already paid, with its paid fact, imports as ready with no payment Event', async () => {
    const { ctx, org, connectionId, stored, events } = await setup()
    const { orderId } = await importOrder(ctx, org, connectionId, unpaid({ awaitingPayment: false, facts: [paidFact()] }))
    expect((await stored(orderId)).awaitingPayment).toBe(false)
    expect(await events(orderId)).toEqual(['order.imported', 'order.channel_fact_recorded'])
  })

  it('a person can cancel an unpaid Order but not process or ship it', async () => {
    const { ctx, org, connectionId, available, stored } = await setup()
    const { orderId } = await importOrder(ctx, org, connectionId, unpaid())
    const statusPushes = () =>
      ctx.queue.enqueued.filter((job) => job.name === 'orders.updateStatus' && (job.payload as { orderId: string }).orderId === orderId)
    for (const to of ['processing', 'shipped'] as const) {
      await expect(changeOrderStatus(ctx, org, orderId, to, user)).rejects.toMatchObject({ code: 'awaiting_payment' })
    }
    await expect(changeOrderStatus(ctx, org, orderId, 'new', user)).rejects.toMatchObject({ code: 'invalid_transition' })
    expect((await stored(orderId)).status).toBe('new')
    expect(statusPushes()).toEqual([])

    await changeOrderStatus(ctx, org, orderId, 'cancelled', user)
    expect((await stored(orderId)).lines[0]?.reservation?.status).toBe('released')
    expect(await available()).toEqual({ stock: 10, reserved: 0, available: 10 })
    expect(statusPushes()).toHaveLength(1)
  })

  it('a Channel cancellation releases the Reservation; a payment arriving afterwards needs a person', async () => {
    const { ctx, org, connectionId, available, stored, events } = await setup()
    const order = unpaid()
    const { orderId } = await importOrder(ctx, org, connectionId, order)

    await importOrder(ctx, org, connectionId, { ...order, facts: [fact('cancelled', 'cancelled')] })
    expect(await stored(orderId)).toMatchObject({ status: 'cancelled', awaitingPayment: true, attentionReasons: [] })
    expect(await available()).toEqual({ stock: 10, reserved: 0, available: 10 })

    const late = { ...order, awaitingPayment: false, facts: [fact('cancelled', 'cancelled'), paidFact('paid', '2026-10-03T10:00:00Z')] }
    await importOrder(ctx, org, connectionId, late)
    expect(await stored(orderId)).toMatchObject({ status: 'cancelled', awaitingPayment: false, attentionReasons: ['channel_fact_conflict'] })
    expect(await available()).toEqual({ stock: 10, reserved: 0, available: 10 })
    expect(await events(orderId)).toContain('order.attention_raised')
  })

  it('a shipped fact ships an unpaid Order and the mark stays until it is paid', async () => {
    const { ctx, org, connectionId, available, stored } = await setup()
    const order = unpaid()
    const { orderId } = await importOrder(ctx, org, connectionId, order)
    await importOrder(ctx, org, connectionId, { ...order, facts: [fact('shipped', 'shipped')] })
    expect(await stored(orderId)).toMatchObject({ status: 'shipped', awaitingPayment: true, attentionReasons: [] })
    expect(await available()).toEqual({ stock: 8, reserved: 0, available: 8 })

    await importOrder(ctx, org, connectionId, { ...order, awaitingPayment: false, facts: [fact('shipped', 'shipped'), paidFact('paid', '2026-10-03T10:00:00Z')] })
    expect(await stored(orderId)).toMatchObject({ status: 'shipped', awaitingPayment: false, attentionReasons: [] })
  })

  it('an unpaid Order with an Unmatched line and a Shortage is marked like any Order', async () => {
    const { ctx, org, connectionId, available, stored } = await setup(1)
    const { orderId } = await importOrder(ctx, org, connectionId, unpaid({ lines: [orderLine('l1', { sku: 'P', quantity: 2 }), orderLine('l2', { sku: 'NOPE' })] }))
    const order = await stored(orderId)
    expect(order).toMatchObject({ awaitingPayment: true, attentionReasons: ['unmatched_line', 'shortage'] })
    expect(order.lines.map((line) => [line.externalId, line.shortage, line.reservation?.status ?? null])).toEqual(
      expect.arrayContaining([
        ['l1', true, 'open'],
        ['l2', false, null],
      ]),
    )
    expect(await available()).toEqual({ stock: 1, reserved: 2, available: -1 })
  })

  it('lists and details Orders awaiting payment', async () => {
    const { ctx, org, connectionId } = await setup()
    const ready = await importOrder(ctx, org, connectionId, buildOrder({ placedAt: '2026-10-02T08:00:00Z', lines: [orderLine('l1', { sku: 'P' })] }))
    const waiting = await importOrder(ctx, org, connectionId, unpaid({ placedAt: '2026-10-01T08:00:00Z' }))

    const all = await listOrders(ctx, org, { skip: 0, take: 10 })
    expect(all.items.map((row) => [row.id, row.awaitingPayment])).toEqual([
      [ready.orderId, false],
      [waiting.orderId, true],
    ])
    expect((await listOrders(ctx, org, { awaitingPayment: true, skip: 0, take: 10 })).items.map((row) => row.id)).toEqual([waiting.orderId])
    expect((await listOrders(ctx, org, { awaitingPayment: false, skip: 0, take: 10 })).items.map((row) => row.id)).toEqual([ready.orderId])
    expect(await getOrder(ctx, org, waiting.orderId)).toMatchObject({ awaitingPayment: true, allowedTransitions: ['cancelled'] })

    const other = await createTestOrganization(ctx.db)
    expect((await listOrders(ctx, other, { awaitingPayment: true, skip: 0, take: 10 })).total).toBe(0)
  })
})
