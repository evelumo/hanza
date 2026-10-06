import { randomUUID } from 'node:crypto'
import { createDb } from '@hanza/db'
import { applyMigration, createTestDatabase, migrationNames } from '@hanza/db/testing'
import { describe, expect, it } from 'vitest'
import { upsertOffers } from '../catalog/offers'
import { createProduct } from '../catalog/products'
import { getAvailability } from '../stock/availability'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, createTestConnection, fact, orderLine, testChannel, user } from '../testing/fixtures'
import { resolveAttention } from './attention'
import { changeOrderStatus } from './change-status'
import { importOrder } from './import'
import { linkOrderLine } from './link-line'
import { getOrder, listOrders } from './queries'
import { rematchUnmatchedLines } from './rematch'

describe.skipIf(!databaseUrl)('orders', () => {
  const context = useTestContext({ connectors: [testChannel] })

  async function setup(stock = 10) {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const connectionId = await createTestConnection(ctx, org)
    const { productId } = await createProduct(ctx, org, { sku: 'P', name: 'Product', stock }, user)
    const available = async (id = productId) => (await getAvailability(ctx.db, org, [id])).get(id)!
    const reservation = async (orderId: string) =>
      (await ctx.db.reservation.findFirst({ where: { orderLine: { orderId } } }))?.status ?? null
    return { ctx, org, connectionId, productId, available, reservation }
  }

  describe('changeOrderStatus', () => {
    it('releases on cancel, consumes on ship and enqueues orders.updateStatus', async () => {
      const { ctx, org, connectionId, available, reservation } = await setup()
      const line = [orderLine('l1', { sku: 'P', quantity: 2 })]
      const a = (await importOrder(ctx, org, connectionId, buildOrder({ lines: line }))).orderId
      const b = (await importOrder(ctx, org, connectionId, buildOrder({ lines: line }))).orderId
      expect(await available()).toEqual({ stock: 10, reserved: 4, available: 6 })

      await changeOrderStatus(ctx, org, a, 'processing', user)
      expect(await reservation(a)).toBe('open')
      await changeOrderStatus(ctx, org, a, 'new', user)
      await changeOrderStatus(ctx, org, a, 'shipped', user)
      expect(await reservation(a)).toBe('consumed')
      await changeOrderStatus(ctx, org, b, 'cancelled', user)
      expect(await reservation(b)).toBe('released')
      expect(await available()).toEqual({ stock: 8, reserved: 0, available: 8 })

      const updates = ctx.queue.enqueued.filter((job) => job.name === 'orders.updateStatus')
      expect(updates.map((job) => job.payload)).toEqual([
        { organizationId: org, orderId: a },
        { organizationId: org, orderId: b },
      ])
      expect(updates[0]?.options).toEqual({ coalesceKey: `orders.updateStatus:${a}` })
      const consumed = await ctx.db.eventLog.findMany({ where: { organizationId: org, type: { in: ['stock.consumed', 'stock.released'] } } })
      expect(consumed.map((event) => event.type).sort()).toEqual(['stock.consumed', 'stock.released'])
    })

    it('refuses transitions out of terminal statuses and to the same status', async () => {
      const { ctx, org, connectionId } = await setup()
      const { orderId } = await importOrder(ctx, org, connectionId, buildOrder({ lines: [orderLine('l1', { sku: 'P' })] }))
      await expect(changeOrderStatus(ctx, org, orderId, 'new', user)).rejects.toMatchObject({ code: 'invalid_transition' })
      await changeOrderStatus(ctx, org, orderId, 'cancelled', user)
      for (const to of ['new', 'processing', 'shipped', 'cancelled'] as const) {
        await expect(changeOrderStatus(ctx, org, orderId, to, user)).rejects.toMatchObject({ code: 'invalid_transition' })
      }
    })

    it('refuses shipped while an Unmatched line exists', async () => {
      const { ctx, org, connectionId } = await setup()
      const { orderId } = await importOrder(ctx, org, connectionId, buildOrder({ lines: [orderLine('l1', { sku: 'NOPE' })] }))
      await expect(changeOrderStatus(ctx, org, orderId, 'shipped', user)).rejects.toMatchObject({ code: 'unmatched_lines' })
      expect((await ctx.db.order.findFirstOrThrow({ where: { id: orderId } })).phase).toBe('new')
    })

    it('removes shortage when cancelled by a person', async () => {
      const { ctx, org, connectionId } = await setup(0)
      const { orderId } = await importOrder(ctx, org, connectionId, buildOrder({ lines: [orderLine('l1', { sku: 'P' })] }))
      await changeOrderStatus(ctx, org, orderId, 'cancelled', user)
      expect((await ctx.db.order.findFirstOrThrow({ where: { id: orderId } })).attentionReasons).toEqual([])
    })

    it('removes unmatched_line and shortage when cancelled by a person', async () => {
      const { ctx, org, connectionId } = await setup(0)
      const order = buildOrder({ lines: [orderLine('l1', { sku: 'P' }), orderLine('l2', { sku: 'NOPE' })] })
      const { orderId } = await importOrder(ctx, org, connectionId, order)
      expect((await ctx.db.order.findFirstOrThrow({ where: { id: orderId } })).attentionReasons).toEqual(['unmatched_line', 'shortage'])
      await changeOrderStatus(ctx, org, orderId, 'cancelled', user)
      expect(await ctx.db.order.findFirstOrThrow({ where: { id: orderId } })).toMatchObject({ phase: 'cancelled', attentionReasons: [] })
    })

    it('leaves a cancelled Order that has Unmatched lines out of the Needs attention list', async () => {
      const { ctx, org, connectionId } = await setup()
      const { orderId } = await importOrder(ctx, org, connectionId, buildOrder({ lines: [orderLine('l1', { sku: 'NOPE' })] }))
      expect((await listOrders(ctx, org, { needsAttention: true, skip: 0, take: 10 })).items.map((row) => row.id)).toEqual([orderId])
      await changeOrderStatus(ctx, org, orderId, 'cancelled', user)
      expect((await listOrders(ctx, org, { needsAttention: true, skip: 0, take: 10 })).total).toBe(0)
    })

    it('migration 20261005112748 clears unmatched_line on cancelled Orders already stored that way, and only those', async () => {
      // Run where it runs: on a database at that migration, whose Orders still have the `status` column the SQL names
      // (the Order statuses migration renames it to `phase` later, ADR 0018). Rows are written in SQL for that reason.
      const migration = '20261005112748_clear_unmatched_line_on_cancelled_orders'
      const database = await createTestDatabase(databaseUrl!, { before: migration })
      const db = createDb(database.url)
      try {
        const org = randomUUID()
        const connectionId = randomUUID()
        await db.$executeRaw`INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES (${org}, 'Org', ${`org-${org}`}, now())`
        await db.$executeRaw`
          INSERT INTO "connection" ("id", "organizationId", "connectorId", "name", "config", "credentials", "updatedAt")
          VALUES (${connectionId}, ${org}, 'fake', 'Channel', '{}', 'sealed', now())`
        const build = async (status: 'new' | 'cancelled' | 'shipped', reasons: Array<'unmatched_line' | 'channel_fact_conflict'>) => {
          const id = randomUUID()
          // The state the rows had before the fix.
          await db.$executeRawUnsafe(
            `INSERT INTO "order" ("id", "organizationId", "connectionId", "externalId", "status", "attentionReasons", "placedAt", "payment",
               "currency", "totalAmount", "buyerName", "shippingAddress", "updatedAt")
             VALUES ($1, $2, $3, $1, $4::"order_status", $5::"attention_reason"[], now(), 'prepaid', 'PLN', 10, 'Buyer', '{}',
               now() - interval '1 hour')`,
            id,
            org,
            connectionId,
            status,
            reasons,
          )
          return id
        }
        const cancelled = await build('cancelled', ['unmatched_line', 'channel_fact_conflict'])
        const cancelledOnly = await build('cancelled', ['unmatched_line'])
        const open = await build('new', ['unmatched_line'])
        const shipped = await build('shipped', ['unmatched_line'])

        const updatedAt = async (id: string) =>
          (await db.$queryRaw<Array<{ updatedAt: Date }>>`SELECT "updatedAt" FROM "order" WHERE "id" = ${id}`)[0]!.updatedAt.getTime()
        const before = { cancelled: await updatedAt(cancelled), open: await updatedAt(open), shipped: await updatedAt(shipped) }
        await applyMigration(database.url, migration)
        const afterFirst = { cancelled: await updatedAt(cancelled), open: await updatedAt(open), shipped: await updatedAt(shipped) }
        expect(afterFirst.cancelled).toBeGreaterThan(before.cancelled)
        expect(afterFirst.open).toBe(before.open)
        expect(afterFirst.shipped).toBe(before.shipped)
        // A second run matches no row, so it changes nothing, not even updatedAt.
        await applyMigration(database.url, migration)
        expect(await updatedAt(cancelled)).toBe(afterFirst.cancelled)

        const expected = [
          [cancelled, 'cancelled', ['channel_fact_conflict']],
          [cancelledOnly, 'cancelled', []],
          [open, 'new', ['unmatched_line']],
          [shipped, 'shipped', ['unmatched_line']],
        ]
        const rows = async (column: 'status' | 'phase') =>
          db.$queryRawUnsafe<Array<{ id: string; value: string; attentionReasons: string[] }>>(
            `SELECT "id", "${column}"::text AS "value", "attentionReasons"::text[] AS "attentionReasons" FROM "order" WHERE "organizationId" = $1`,
            org,
          )
        const byId = (list: Array<{ id: string; value: string; attentionReasons: string[] }>) =>
          expected.map(([id]) => list.find((row) => row.id === id)).map((row) => [row?.id, row?.value, row?.attentionReasons])
        expect(byId(await rows('status'))).toEqual(expected)

        // Every later migration keeps the result: the phase is the old status and the reasons stay as they are.
        for (const later of (await migrationNames()).filter((name) => name > migration)) await applyMigration(database.url, later)
        expect(byId(await rows('phase'))).toEqual(expected)
      } finally {
        await db.$disconnect()
        await database.drop()
      }
    })
  })

  describe('linkOrderLine', () => {
    async function unmatchedOrder(env: Awaited<ReturnType<typeof setup>>, quantity = 2, facts = [] as ReturnType<typeof fact>[]) {
      const order = buildOrder({ lines: [orderLine('l1', { offerExternalId: 'offer-x', sku: 'NOPE', quantity })], facts })
      const { orderId } = await importOrder(env.ctx, env.org, env.connectionId, order)
      const line = await env.ctx.db.orderLine.findFirstOrThrow({ where: { orderId } })
      return { orderId, lineId: line.id }
    }

    it('on a new Order: open Reservation, clears unmatched_line, links the Offer', async () => {
      const env = await setup()
      const { ctx, org, connectionId, productId, available } = env
      await upsertOffers(ctx, org, connectionId, [{ externalId: 'offer-x', sku: 'NOPE', name: 'X', url: null }], new Date())
      const { orderId, lineId } = await unmatchedOrder(env)
      ctx.queue.waiting.length = 0

      await linkOrderLine(ctx, org, lineId, productId, user)

      const order = await ctx.db.order.findFirstOrThrow({ where: { id: orderId }, include: { lines: { include: { reservation: true } } } })
      expect(order.attentionReasons).toEqual([])
      expect(order.lines[0]).toMatchObject({ productId, reservation: { status: 'open', units: 2 } })
      expect(await available()).toEqual({ stock: 10, reserved: 2, available: 8 })
      const offer = await ctx.db.offer.findFirstOrThrow({ where: { organizationId: org, externalId: 'offer-x' } })
      expect(offer).toMatchObject({ productId, linkedBy: 'manual' })
      expect(offer.stockPushSeq).toBeGreaterThan(offer.stockPushedSeq)
      expect(ctx.queue.waiting.map((job) => job.payload)).toEqual([{ organizationId: org, connectionId }])
      const events = await ctx.db.eventLog.findMany({ where: { organizationId: org, type: { in: ['order.line_linked', 'offer.linked'] } } })
      expect(events.map((event) => event.type).sort()).toEqual(['offer.linked', 'order.line_linked'])

      await expect(linkOrderLine(ctx, org, lineId, productId, user)).rejects.toMatchObject({ code: 'already_linked' })
    })

    it('on a shipped Order: consumed Reservation and Stock decreases', async () => {
      const env = await setup()
      const { orderId, lineId } = await unmatchedOrder(env, 2, [fact('s', 'shipped')])
      expect((await env.ctx.db.order.findFirstOrThrow({ where: { id: orderId } })).phase).toBe('shipped')

      await linkOrderLine(env.ctx, env.org, lineId, env.productId, user)

      expect(await env.reservation(orderId)).toBe('consumed')
      expect(await env.available()).toEqual({ stock: 8, reserved: 0, available: 8 })
      expect(await env.ctx.db.eventLog.count({ where: { organizationId: env.org, type: 'stock.consumed' } })).toBe(1)
    })

    it('on a cancelled Order: no Reservation', async () => {
      const env = await setup()
      const { orderId, lineId } = await unmatchedOrder(env, 2, [fact('c', 'cancelled')])
      await linkOrderLine(env.ctx, env.org, lineId, env.productId, user)
      expect(await env.reservation(orderId)).toBeNull()
      expect(await env.available()).toEqual({ stock: 10, reserved: 0, available: 10 })
      expect((await env.ctx.db.order.findFirstOrThrow({ where: { id: orderId } })).attentionReasons).toEqual([])
    })

    it('raises shortage when Stock does not cover the line', async () => {
      const env = await setup(1)
      const { orderId, lineId } = await unmatchedOrder(env, 2)
      await linkOrderLine(env.ctx, env.org, lineId, env.productId, user)
      expect((await env.ctx.db.order.findFirstOrThrow({ where: { id: orderId } })).attentionReasons).toEqual(['shortage'])
      expect((await env.ctx.db.orderLine.findFirstOrThrow({ where: { id: lineId } })).shortage).toBe(true)
    })

    it('rematches Unmatched lines of open Orders after createProduct', async () => {
      const env = await setup()
      const open = await unmatchedOrder(env, 1)
      const shipped = await unmatchedOrder(env, 1, [fact('s', 'shipped')])

      const { productId } = await createProduct(env.ctx, env.org, { sku: 'NOPE', name: 'Now exists', stock: 5 }, user)

      expect((await env.ctx.db.orderLine.findFirstOrThrow({ where: { id: open.lineId } })).productId).toBe(productId)
      expect(await env.reservation(open.orderId)).toBe('open')
      expect((await env.ctx.db.order.findFirstOrThrow({ where: { id: open.orderId } })).attentionReasons).toEqual([])
      // Shipped Orders are not rematched automatically.
      expect((await env.ctx.db.orderLine.findFirstOrThrow({ where: { id: shipped.lineId } })).productId).toBeNull()
      const linked = await env.ctx.db.eventLog.findFirstOrThrow({ where: { organizationId: env.org, type: 'order.line_linked' } })
      expect(linked.payload).toMatchObject({ actor: { type: 'system' } })
    })
  })

  describe('rematchUnmatchedLines', () => {
    it('is not starved by 500 older lines that never match', async () => {
      const { ctx, org, connectionId } = await setup()
      const never = Array.from({ length: 500 }, (_, index) => orderLine(`n${index}`, { sku: 'NEVER' }))
      await importOrder(ctx, org, connectionId, buildOrder({ lines: never }))
      const { orderId } = await importOrder(ctx, org, connectionId, buildOrder({ lines: [orderLine('l1', { sku: 'LATER' })] }))

      const { productId } = await createProduct(ctx, org, { sku: 'LATER', name: 'Later', stock: 1 }, user)

      expect((await ctx.db.orderLine.findFirstOrThrow({ where: { orderId } })).productId).toBe(productId)
      expect(await ctx.db.orderLine.count({ where: { organizationId: org, productId: null } })).toBe(500)
    })

    it('prefers the linked Offer over the SKU, like import', async () => {
      const { ctx, org, connectionId } = await setup()
      await upsertOffers(ctx, org, connectionId, [{ externalId: 'offer-z', sku: null, name: 'Z', url: null }], new Date())
      const { orderId } = await importOrder(
        ctx,
        org,
        connectionId,
        buildOrder({ lines: [orderLine('l1', { offerExternalId: 'offer-z', sku: 'ZED' })] }),
      )
      // Written directly, so that both rules can match when rematch runs.
      await ctx.db.product.create({ data: { organizationId: org, sku: 'ZED', name: 'By SKU' } })
      const byOffer = await ctx.db.product.create({ data: { organizationId: org, sku: 'OTHER', name: 'By offer' } })
      await ctx.db.offer.updateMany({ where: { organizationId: org, externalId: 'offer-z' }, data: { productId: byOffer.id, linkedBy: 'manual' } })

      expect(await rematchUnmatchedLines(ctx, org)).toEqual({ linked: 1 })

      expect((await ctx.db.orderLine.findFirstOrThrow({ where: { orderId } })).productId).toBe(byOffer.id)
    })
  })

  it('resolveAttention clears every reason except unmatched_line', async () => {
    const { ctx, org, connectionId } = await setup(0)
    const order = buildOrder({ lines: [orderLine('l1', { sku: 'P' }), orderLine('l2', { sku: 'NOPE' })] })
    const { orderId } = await importOrder(ctx, org, connectionId, order)
    await resolveAttention(ctx, org, orderId, user)
    expect((await ctx.db.order.findFirstOrThrow({ where: { id: orderId } })).attentionReasons).toEqual(['unmatched_line'])
    const resolved = await ctx.db.eventLog.findFirstOrThrow({ where: { subjectId: orderId, type: 'order.attention_resolved' } })
    expect(resolved.payload).toEqual({ cleared: ['shortage'], actor: user })
  })

  it('lists and details Orders', async () => {
    const { ctx, org, connectionId, productId } = await setup()
    const ok = await importOrder(
      ctx,
      org,
      connectionId,
      buildOrder({ placedAt: '2026-10-02T08:00:00Z', total: { amount: '84.00', currency: 'PLN' }, lines: [orderLine('l1', { sku: 'P' })] }),
    )
    const attention = await importOrder(ctx, org, connectionId, buildOrder({ placedAt: '2026-10-01T08:00:00Z', lines: [orderLine('l1', { sku: 'NOPE' })] }))

    const all = await listOrders(ctx, org, { skip: 0, take: 10 })
    expect(all.total).toBe(2)
    expect(all.items.map((row) => row.id)).toEqual([ok.orderId, attention.orderId])
    expect(all.items[0]).toMatchObject({ connectionName: 'Test channel', buyerName: 'John Test', total: { amount: '84', currency: 'PLN' } })
    expect((await listOrders(ctx, org, { needsAttention: true, skip: 0, take: 10 })).items.map((row) => row.id)).toEqual([attention.orderId])
    expect((await listOrders(ctx, org, { needsAttention: false, skip: 0, take: 10 })).items.map((row) => row.id)).toEqual([ok.orderId])
    expect((await listOrders(ctx, org, { phase: 'cancelled', skip: 0, take: 10 })).total).toBe(0)

    const detail = await getOrder(ctx, org, ok.orderId)
    expect(detail).toMatchObject({
      phase: 'new',
      status: { name: null, color: null, phase: 'new' },
      payment: 'prepaid',
      buyer: { name: 'John Test', email: 'john.test@example.com', phone: null, login: 'john_test' },
      shippingAddress: { city: 'Warsaw', countryCode: 'PL' },
      billingAddress: null,
      lines: [{ externalId: 'l1', productId, productSku: 'P', productName: 'Product', reservationStatus: 'open', unitPrice: { amount: '10', currency: 'PLN' } }],
      facts: [],
      allowedTransitions: ['processing', 'shipped', 'cancelled'],
    })
    expect(detail?.allowedStatuses.map((status) => [status.phase, status.name])).toEqual([
      ['processing', null],
      ['shipped', null],
      ['cancelled', null],
    ])
    expect(detail?.events.map((event) => event.type)).toEqual(['order.imported'])
  })
})
