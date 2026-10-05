import { describe, expect, it } from 'vitest'
import { upsertOffers } from '../catalog/offers'
import { createProduct } from '../catalog/products'
import { getAvailability } from '../stock/availability'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, createTestConnection, fact, orderLine, user } from '../testing/fixtures'
import { changeOrderStatus } from './change-status'
import { importOrder } from './import'

describe.skipIf(!databaseUrl)('importOrder', () => {
  const context = useTestContext()

  async function setup(stock = 10) {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const connectionId = await createTestConnection(ctx, org)
    const { productId } = await createProduct(ctx, org, { sku: 'P', name: 'Product', stock }, user)
    const available = async () => (await getAvailability(ctx.db, org, [productId])).get(productId)!
    const counts = async () => ({
      orders: await ctx.db.order.count({ where: { organizationId: org } }),
      lines: await ctx.db.orderLine.count({ where: { organizationId: org } }),
      reservations: await ctx.db.reservation.count({ where: { organizationId: org } }),
      facts: await ctx.db.orderChannelFact.count({ where: { organizationId: org } }),
      events: await ctx.db.eventLog.count({ where: { organizationId: org } }),
    })
    return { ctx, org, connectionId, productId, available, counts }
  }

  it('creates the Order, its lines, Reservations and Events', async () => {
    const { ctx, org, connectionId, productId, available } = await setup()
    await upsertOffers(ctx, org, connectionId, [{ externalId: 'offer-p', sku: 'P', name: 'Offer', url: null }], new Date())
    ctx.queue.waiting.length = 0
    const order = buildOrder({
      total: { amount: '79.98', currency: 'PLN' },
      lines: [orderLine('l1', { offerExternalId: 'offer-p', sku: 'P', quantity: 2, unitPrice: { amount: '39.99', currency: 'PLN' } })],
    })

    const result = await importOrder(ctx, org, connectionId, order)

    expect(result).toMatchObject({ created: true, factsApplied: 0 })
    const stored = await ctx.db.order.findFirstOrThrow({ where: { id: result.orderId }, include: { lines: { include: { reservation: true } } } })
    expect(stored).toMatchObject({ status: 'new', attentionReasons: [], currency: 'PLN', shippingCountryCode: 'PL', closedAt: null })
    // Buyer data is sealed (ADR 0011): no plaintext column is written.
    expect(stored).toMatchObject({ buyerName: null, buyerEmail: null, shippingAddress: null, billingAddress: null })
    expect(stored.buyerData).toMatch(/^v1:/)
    expect(stored.buyerEmailIndex).toMatch(/^v1:/)
    expect(stored.totalAmount.toFixed()).toBe('79.98')
    expect(stored.lines).toHaveLength(1)
    expect(stored.lines[0]).toMatchObject({ productId, shortage: false, reservation: { units: 2, status: 'open', productId } })
    expect(await available()).toEqual({ stock: 10, reserved: 2, available: 8 })

    const events = await ctx.db.eventLog.findMany({ where: { organizationId: org, OR: [{ subjectId: result.orderId }, { type: 'stock.reserved' }] } })
    expect(events.map((event) => event.type).sort()).toEqual(['order.imported', 'stock.reserved'])
    expect(events.find((event) => event.type === 'order.imported')?.payload).toEqual({
      connectionId,
      externalId: order.externalId,
      lineCount: 1,
      unmatchedLines: 0,
      shortageLines: 0,
    })
    expect(JSON.stringify(events.map((event) => event.payload))).not.toContain('John Test')
    // The linked Offer is marked and a push is requested.
    expect(await ctx.db.offer.findFirstOrThrow({ where: { organizationId: org } })).toMatchObject({ stockPushSeq: 2 })
    expect(ctx.queue.waiting.map((job) => job.name)).toEqual(['stock.push'])
  })

  it('is idempotent: importing the same Order again changes nothing', async () => {
    const { ctx, org, connectionId, counts } = await setup()
    const order = buildOrder({ lines: [orderLine('l1', { sku: 'P' }), orderLine('l2', { sku: 'UNKNOWN' })], facts: [fact('f1', 'cancelled')] })
    await importOrder(ctx, org, connectionId, order)
    const before = await counts()

    const again = await importOrder(ctx, org, connectionId, order)

    expect(again).toMatchObject({ created: false, factsApplied: 0 })
    expect(await counts()).toEqual(before)
  })

  it('imports an Unmatched line without a Reservation and raises unmatched_line', async () => {
    const { ctx, org, connectionId } = await setup()
    const { orderId } = await importOrder(ctx, org, connectionId, buildOrder({ lines: [orderLine('l1', { sku: 'NOPE' })] }))
    const order = await ctx.db.order.findFirstOrThrow({ where: { id: orderId }, include: { lines: { include: { reservation: true } } } })
    expect(order.attentionReasons).toEqual(['unmatched_line'])
    expect(order.lines[0]).toMatchObject({ productId: null, reservation: null })
    const raised = await ctx.db.eventLog.findFirstOrThrow({ where: { subjectId: orderId, type: 'order.attention_raised' } })
    expect(raised.payload).toEqual({ reasons: ['unmatched_line'] })
  })

  it('marks a Shortage on the line and the Order and lets Available go negative', async () => {
    const { ctx, org, connectionId, available } = await setup(1)
    const { orderId } = await importOrder(ctx, org, connectionId, buildOrder({ lines: [orderLine('l1', { sku: 'P', quantity: 3 })] }))
    const order = await ctx.db.order.findFirstOrThrow({ where: { id: orderId }, include: { lines: { include: { reservation: true } } } })
    expect(order.attentionReasons).toEqual(['shortage'])
    expect(order.lines[0]).toMatchObject({ shortage: true, reservation: { status: 'open', units: 3 } })
    expect(await available()).toEqual({ stock: 1, reserved: 3, available: -2 })
  })

  it('reserves two lines of one Product one after the other', async () => {
    const { ctx, org, connectionId, available } = await setup(3)
    const { orderId } = await importOrder(
      ctx,
      org,
      connectionId,
      buildOrder({ lines: [orderLine('l1', { sku: 'P', quantity: 2 }), orderLine('l2', { sku: 'P', quantity: 2 })] }),
    )
    const lines = await ctx.db.orderLine.findMany({ where: { orderId }, orderBy: { externalId: 'asc' } })
    expect(lines.map((line) => [line.externalId, line.shortage])).toEqual([
      ['l1', false],
      ['l2', true],
    ])
    expect(await available()).toEqual({ stock: 3, reserved: 4, available: -1 })
  })

  it('matches by the linked Offer before the SKU', async () => {
    const { ctx, org, connectionId } = await setup()
    const other = (await createProduct(ctx, org, { sku: 'OTHER', name: 'Other', stock: 0 }, user)).productId
    await upsertOffers(ctx, org, connectionId, [{ externalId: 'offer-o', sku: 'OTHER', name: 'O', url: null }], new Date())
    const { orderId } = await importOrder(ctx, org, connectionId, buildOrder({ lines: [orderLine('l1', { offerExternalId: 'offer-o', sku: 'P' })] }))
    expect((await ctx.db.orderLine.findFirstOrThrow({ where: { orderId } })).productId).toBe(other)
  })

  it('applies facts from a later import once, in occurredAt order', async () => {
    const { ctx, org, connectionId, available, counts } = await setup()
    const order = buildOrder({ lines: [orderLine('l1', { sku: 'P', quantity: 2 })] })
    const { orderId } = await importOrder(ctx, org, connectionId, order)
    await changeOrderStatus(ctx, org, orderId, 'processing', user)

    const withFacts = {
      ...order,
      facts: [fact('late', 'shipped', '2026-10-03T10:00:00Z'), fact('early', 'cancelled', '2026-10-02T10:00:00+02:00')],
    }
    expect(await importOrder(ctx, org, connectionId, withFacts)).toMatchObject({ created: false, factsApplied: 2 })
    const before = await counts()
    expect(await importOrder(ctx, org, connectionId, withFacts)).toMatchObject({ factsApplied: 0 })
    expect(await counts()).toEqual(before)

    // early: processing + cancelled → cancelled (released), reason; late: cancelled + shipped → conflict.
    const stored = await ctx.db.order.findFirstOrThrow({ where: { id: orderId } })
    expect(stored.status).toBe('cancelled')
    expect(stored.attentionReasons).toEqual(['cancelled_while_processing', 'channel_fact_conflict'])
    expect(await available()).toEqual({ stock: 10, reserved: 0, available: 10 })
    const changed = await ctx.db.eventLog.findMany({ where: { subjectId: orderId, type: 'order.status_changed' }, orderBy: { id: 'asc' } })
    expect(changed.map((event) => event.payload)).toEqual([
      { from: 'new', to: 'processing', cause: 'user', factId: null, actor: user },
      { from: 'processing', to: 'cancelled', cause: 'channel_fact', factId: 'early', actor: { type: 'system' } },
    ])
    // A fact-driven change is never pushed back to the Channel.
    expect(ctx.queue.enqueued.filter((job) => job.name === 'orders.updateStatus')).toHaveLength(1)
  })

  describe('every cell of the Channel fact table', () => {
    const cells = [
      { from: 'new', fact: 'cancelled', status: 'cancelled', reasons: [], reservation: 'released', stock: 10 },
      { from: 'new', fact: 'shipped', status: 'shipped', reasons: [], reservation: 'consumed', stock: 8 },
      { from: 'processing', fact: 'cancelled', status: 'cancelled', reasons: ['cancelled_while_processing'], reservation: 'released', stock: 10 },
      { from: 'processing', fact: 'shipped', status: 'shipped', reasons: [], reservation: 'consumed', stock: 8 },
      { from: 'shipped', fact: 'cancelled', status: 'shipped', reasons: ['channel_fact_conflict'], reservation: 'consumed', stock: 8 },
      { from: 'shipped', fact: 'shipped', status: 'shipped', reasons: [], reservation: 'consumed', stock: 8 },
      { from: 'cancelled', fact: 'cancelled', status: 'cancelled', reasons: [], reservation: 'released', stock: 10 },
      { from: 'cancelled', fact: 'shipped', status: 'cancelled', reasons: ['channel_fact_conflict'], reservation: 'released', stock: 10 },
    ] as const

    it.each(cells)('$from + $fact → $status $reasons', async (cell) => {
      const { ctx, org, connectionId, available } = await setup()
      const order = buildOrder({ lines: [orderLine('l1', { sku: 'P', quantity: 2 })] })
      const { orderId } = await importOrder(ctx, org, connectionId, order)
      if (cell.from !== 'new') await changeOrderStatus(ctx, org, orderId, cell.from, user)

      await importOrder(ctx, org, connectionId, { ...order, facts: [fact('f', cell.fact)] })

      const stored = await ctx.db.order.findFirstOrThrow({ where: { id: orderId }, include: { lines: { include: { reservation: true } } } })
      expect(stored.status).toBe(cell.status)
      expect(stored.attentionReasons).toEqual(cell.reasons)
      expect(stored.lines[0]?.reservation?.status).toBe(cell.reservation)
      expect((await available()).stock).toBe(cell.stock)
      expect(await ctx.db.orderChannelFact.count({ where: { orderId } })).toBe(1)
    })
  })

  it('removes shortage when a fact cancels the Order', async () => {
    const { ctx, org, connectionId } = await setup(0)
    const order = buildOrder({ lines: [orderLine('l1', { sku: 'P' }), orderLine('l2', { sku: 'NOPE' })] })
    const { orderId } = await importOrder(ctx, org, connectionId, order)
    expect((await ctx.db.order.findFirstOrThrow({ where: { id: orderId } })).attentionReasons).toEqual(['unmatched_line', 'shortage'])
    await importOrder(ctx, org, connectionId, { ...order, facts: [fact('c', 'cancelled')] })
    expect((await ctx.db.order.findFirstOrThrow({ where: { id: orderId } })).attentionReasons).toEqual(['unmatched_line'])
  })
})
