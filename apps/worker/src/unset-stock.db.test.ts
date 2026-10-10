import { createFakeChannel, type FakeChannel } from '@hanza/connector-fake'
import {
  addConnection,
  changeOrderStatus,
  coalesceKeys,
  createProductsFromOffers,
  getProduct,
  jobs,
  ordersPullRef,
  setStock,
  type Actor,
} from '@hanza/core'
import { createTestContext, createTestOrganization, type TestContext } from '@hanza/core/testing'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

const databaseUrl = inject('hanzaTestDatabaseUrl')
const user: Actor = { type: 'user', userId: 'user-1' }

// Issue #137: Products created from a Channel's Offers have unset Stock, and Hanza tells that Channel nothing about
// them until someone saves their Stock. Before, it told it 0, which ends an Offer on Allegro. The fake's seed:
// fake-order-1 (open) wants 2 × FAKE-SKU-1, fake-order-2 (cancelled) one each of FAKE-SKU-2 and FAKE-SKU-3,
// fake-offer-4 has no SKU.
describe.skipIf(!databaseUrl)('unset Stock end to end (real Postgres, in-memory queue, fake Channel)', () => {
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
  }

  /** Every number the fake Channel was sent for this Offer, oldest first. */
  function pushedTo(offerExternalId: string): number[] {
    return fake.stockPushes.flat().flatMap((level) => (level.offerExternalId === offerExternalId ? [level.available] : []))
  }

  const seedOffers = ['fake-offer-1', 'fake-offer-2', 'fake-offer-3', 'fake-offer-5']

  it('1. a fake Connection syncs: Offers without a Product, fake-order-1 with an Unmatched line', async () => {
    connectionId = (
      await addConnection(ctx, org, { connectorId: 'fake', name: 'Test channel', config: { failMode: 'none' }, credentials: { apiKey: 'test' } }, user)
    ).connectionId
    await drain()
    expect(await ctx.db.offer.count({ where: { organizationId: org, connectionId, productId: null } })).toBe(5)
    expect(fake.stockPushes).toEqual([])
  })

  it('2. creating Products from the Offers sends the Channel nothing, even after fake-order-1 reserves', async () => {
    const offers = await ctx.db.offer.findMany({ where: { organizationId: org, connectionId, sku: { not: null } }, orderBy: { externalId: 'asc' } })
    const { created, skipped } = await createProductsFromOffers(ctx, org, offers.map((offer) => offer.id), user)
    expect(skipped).toEqual([])
    expect(created).toHaveLength(4)
    for (const offer of await ctx.db.offer.findMany({ where: { organizationId: org, connectionId, productId: { not: null } }, include: { product: true } })) {
      products[offer.product!.sku] = offer.productId!
    }
    await drain()

    // fake-order-1's line was matched by the rematch and reserves against the unset Stock: a Shortage, no Stock row.
    const first = await ctx.db.order.findFirstOrThrow({
      where: { organizationId: org, externalId: 'fake-order-1' },
      include: { lines: { include: { reservation: true } } },
    })
    expect(first.lines.map((line) => [line.productId, line.shortage, line.reservation?.status])).toEqual([[products['FAKE-SKU-1'], true, 'open']])
    expect(await ctx.db.stock.count({ where: { organizationId: org } })).toBe(0)

    for (const offer of seedOffers) expect(pushedTo(offer)).toEqual([])
    expect(fake.stockPushes).toEqual([])
    const mug = await getProduct(ctx, org, products['FAKE-SKU-1']!)
    expect(mug).toMatchObject({ stockSet: false, stock: 0, reserved: 2, available: -2 })
    expect(mug?.offers.map((offer) => offer.stockStatus)).toEqual(['unset'])
  })

  it('3. saving Stock sends the number, to that Offer only', async () => {
    await setStock(ctx, org, products['FAKE-SKU-1']!, 5, user)
    await drain()
    expect(pushedTo('fake-offer-1')).toEqual([3])
    for (const offer of ['fake-offer-2', 'fake-offer-3', 'fake-offer-5']) expect(pushedTo(offer)).toEqual([])
    expect((await getProduct(ctx, org, products['FAKE-SKU-1']!))?.offers.map((offer) => offer.stockStatus)).toEqual(['pushed'])
  })

  it('4. saving 0 over unset Stock is a number too, and is sent', async () => {
    await setStock(ctx, org, products['FAKE-SKU-2']!, 0, user)
    await drain()
    expect(pushedTo('fake-offer-2')).toEqual([0])
    expect(pushedTo('fake-offer-3')).toEqual([])
  })

  it('5. shipping an Order of a Product with unset Stock takes nothing off Stock and sends the Channel no number', async () => {
    fake.addOrder({
      externalId: 'poster-order',
      placedAt: '2026-10-05T09:00:00Z',
      payment: 'prepaid',
      total: { amount: '25.00', currency: 'PLN' },
      buyer: { name: 'Jane Test', email: 'jane.test@example.com', phone: null, login: 'jane_test' },
      shippingAddress: {
        name: 'Jane Test',
        company: null,
        street: '2 Example Street',
        postalCode: '00-002',
        city: 'Warsaw',
        countryCode: 'PL',
        phone: null,
        taxId: null,
      },
      billingAddress: null,
      lines: [
        { externalId: 'l1', offerExternalId: 'fake-offer-3', sku: 'FAKE-SKU-3', name: 'Poster A3', quantity: 1, unitPrice: { amount: '25.00', currency: 'PLN' } },
      ],
      facts: [],
    })
    await ctx.queue.enqueue(ordersPullRef, { organizationId: org, connectionId, trigger: 'schedule' }, { coalesceKey: coalesceKeys.ordersPull(connectionId) })
    await drain()
    const poster = await ctx.db.order.findFirstOrThrow({ where: { organizationId: org, externalId: 'poster-order' } })
    await changeOrderStatus(ctx, org, poster.id, 'shipped', user)
    await drain()

    expect(await ctx.db.reservation.findFirstOrThrow({ where: { organizationId: org, productId: products['FAKE-SKU-3'] } })).toMatchObject({
      status: 'consumed',
    })
    expect(await ctx.db.stock.count({ where: { organizationId: org, productId: products['FAKE-SKU-3'] } })).toBe(0)
    expect(pushedTo('fake-offer-3')).toEqual([])
    expect(fake.statusUpdates.filter((update) => update.orderExternalId === 'poster-order').map((update) => update.phase)).toEqual(['shipped'])
  })
})
