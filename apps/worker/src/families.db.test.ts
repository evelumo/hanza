import { createFakeChannel } from '@hanza/connector-fake'
import {
  addConnection,
  addProductToFamily,
  changeOrderStatus,
  coalesceKeys,
  createFamily,
  createProduct,
  deleteFamily,
  getAvailability,
  getFamily,
  jobs,
  linkOffer,
  ordersPullRef,
  type Actor,
} from '@hanza/core'
import { createTestContext, createTestOrganization } from '@hanza/core/testing'
import { afterAll, describe, expect, inject, it } from 'vitest'

const databaseUrl = inject('hanzaTestDatabaseUrl')
const user: Actor = { type: 'user', userId: 'user-1' }

/**
 * A Product family only groups Products. This runs the engine scenario (Offer pull and SKU link, Order import with
 * Reservations, a Shortage and Unmatched lines, stock push, a manual link, shipping, a cancellation reported by the Channel)
 * twice, with the Products in a family and without, and expects the same observable result.
 */
async function runScenario(options: { grouped: boolean }) {
  const fake = createFakeChannel()
  const ctx = createTestContext({ databaseUrl: databaseUrl!, connectors: [fake.connector] })
  try {
    const org = await createTestOrganization(ctx.db)
    const drain = async () => {
      const result = await ctx.queue.drain(ctx, jobs)
      expect(result.failed).toEqual([])
      expect(ctx.queue.waiting).toEqual([])
    }

    const skus = ['FAKE-SKU-1', 'FAKE-SKU-2', 'FAKE-SKU-3', 'STICKERS']
    const stock = { 'FAKE-SKU-1': 5, 'FAKE-SKU-2': 1, 'FAKE-SKU-3': 0, STICKERS: 10 } as const
    const productIds: Record<string, string> = {}
    for (const sku of skus) productIds[sku] = (await createProduct(ctx, org, { sku, name: sku, stock: stock[sku as keyof typeof stock] }, user)).productId
    let familyId: string | null = null
    if (options.grouped) {
      familyId = (await createFamily(ctx, org, { name: 'Fake family', attributes: ['Size'] }, user)).familyId
      for (const [index, sku] of skus.entries()) await addProductToFamily(ctx, org, familyId, productIds[sku]!, { Size: `size ${index}` }, user)
    }

    const connectionId = (
      await addConnection(ctx, org, { connectorId: 'fake', name: 'Test channel', config: { failMode: 'none' }, credentials: { apiKey: 'test' } }, user)
    ).connectionId
    await drain()

    const offer4 = await ctx.db.offer.findFirstOrThrow({ where: { organizationId: org, connectionId, externalId: 'fake-offer-4' } })
    await linkOffer(ctx, org, offer4.id, productIds.STICKERS!, user)
    await drain()
    const first = await ctx.db.order.findFirstOrThrow({ where: { organizationId: org, externalId: 'fake-order-1' } })
    await changeOrderStatus(ctx, org, first.id, 'shipped', user)
    await drain()
    fake.addFact('fake-order-4', { id: 'fake-order-4:cancelled', type: 'cancelled', occurredAt: '2026-10-03T10:00:00Z', note: null })
    await ctx.queue.enqueue(ordersPullRef, { organizationId: org, connectionId, trigger: 'schedule' }, { coalesceKey: coalesceKeys.ordersPull(connectionId) })
    await drain()

    const bySku = new Map(Object.entries(productIds).map(([sku, id]) => [id, sku]))
    const skuOf = (id: string | null) => (id ? bySku.get(id) ?? 'unknown' : null)
    const snapshot = async () => {
      const availability = await getAvailability(ctx.db, org, Object.values(productIds))
      const offers = await ctx.db.offer.findMany({ where: { organizationId: org, connectionId }, orderBy: { externalId: 'asc' } })
      const orders = await ctx.db.order.findMany({
        where: { organizationId: org },
        orderBy: { externalId: 'asc' },
        include: { lines: { orderBy: { externalId: 'asc' }, include: { reservation: true } } },
      })
      return {
        availability: Object.fromEntries(skus.map((sku) => [sku, availability.get(productIds[sku]!)])),
        offers: offers.map((offer) => [offer.externalId, skuOf(offer.productId), offer.linkedBy, offer.stockPushSeq, offer.stockPushedSeq, offer.lastPushedAvailable]),
        orders: orders.map((order) => [
          order.externalId,
          order.status,
          order.attentionReasons,
          order.lines.map((line) => [line.externalId, skuOf(line.productId), line.quantity, line.shortage, line.reservation?.status ?? null, line.reservation?.units ?? null]),
        ]),
        pushes: fake.stockPushes.map((levels) => levels.map((level) => [level.offerExternalId, level.available])),
        statusUpdates: fake.statusUpdates,
        // Everything the engine wrote, except the family's own Events.
        eventTypes: (await ctx.db.eventLog.findMany({ where: { organizationId: org, NOT: { type: { startsWith: 'family.' } } }, select: { type: true } }))
          .map((event) => event.type)
          .sort(),
      }
    }

    const result = await snapshot()
    let afterDelete: Awaited<ReturnType<typeof snapshot>> | null = null
    let members = 0
    if (familyId) {
      members = (await getFamily(ctx, org, familyId))?.members.length ?? 0
      await deleteFamily(ctx, org, familyId, user)
      await ctx.queue.enqueue(ordersPullRef, { organizationId: org, connectionId, trigger: 'schedule' }, { coalesceKey: coalesceKeys.ordersPull(connectionId) })
      await drain()
      afterDelete = await snapshot()
    }
    return { result, afterDelete, members, org, db: ctx.db }
  } catch (error) {
    await ctx.db.$disconnect()
    throw error
  }
}

describe.skipIf(!databaseUrl)('Product families do not change what a Product is (real Postgres, in-memory queue, fake Channel)', () => {
  const connections: Array<{ $disconnect: () => Promise<void> }> = []
  afterAll(async () => {
    await Promise.all(connections.map((db) => db.$disconnect()))
  })

  it('Order import, Reservations, Shortage and stock push behave exactly as without a family', async () => {
    const plain = await runScenario({ grouped: false })
    const grouped = await runScenario({ grouped: true })
    connections.push(plain.db, grouped.db)

    expect(grouped.members).toBe(4)
    expect(grouped.result).toEqual(plain.result)

    // And these are the known values of the engine scenario (see engine.db.test.ts).
    expect(grouped.result.availability).toEqual({
      'FAKE-SKU-1': { stock: 3, reserved: 0, available: 3 },
      'FAKE-SKU-2': { stock: 1, reserved: 0, available: 1 },
      'FAKE-SKU-3': { stock: 0, reserved: 0, available: 0 },
      STICKERS: { stock: 10, reserved: 0, available: 10 },
    })
    expect(grouped.result.offers.map(([externalId, sku, linkedBy, , , pushed]) => [externalId, sku, linkedBy, pushed])).toEqual([
      ['fake-offer-1', 'FAKE-SKU-1', 'sku', 3],
      ['fake-offer-2', 'FAKE-SKU-2', 'sku', 1],
      ['fake-offer-3', 'FAKE-SKU-3', 'sku', 0],
      ['fake-offer-4', 'STICKERS', 'manual', 10],
      ['fake-offer-5', null, null, null],
    ])
    const orders = Object.fromEntries(grouped.result.orders.map(([externalId, status, attention, lines]) => [externalId, { status, attention, lines }]))
    expect(orders['fake-order-1']).toMatchObject({ status: 'shipped', attention: [] })
    expect(orders['fake-order-2']).toMatchObject({ status: 'cancelled', attention: [] })
    expect((orders['fake-order-2']!.lines as unknown[][]).map((line) => [line[1], line[3], line[4]])).toEqual([
      ['FAKE-SKU-2', false, 'released'],
      ['FAKE-SKU-3', true, 'released'],
    ])
    expect(orders['fake-order-3']).toMatchObject({ status: 'new', attention: ['unmatched_line'] })
    expect(orders['fake-order-4']).toMatchObject({ status: 'cancelled' })
    expect(grouped.result.statusUpdates).toContainEqual({ orderExternalId: 'fake-order-1', status: 'shipped' })

    // Deleting the family ungroups the Products and changes nothing else.
    expect(grouped.afterDelete).toEqual(grouped.result)
    expect(await grouped.db.productFamily.count({ where: { organizationId: grouped.org } })).toBe(0)
    expect(await grouped.db.product.count({ where: { organizationId: grouped.org, familyId: null } })).toBe(4)
  })
})
