import { createFakeChannel, FAKE_REJECTED_CODE, type FakeChannel } from '@hanza/connector-fake'
import {
  addConnection,
  coalesceKeys,
  createProduct,
  getOffer,
  jobs,
  requestSync,
  retryOfferPush,
  setBasePrice,
  setStock,
  stockPushRef,
  type Actor,
} from '@hanza/core'
import { createTestContext, createTestOrganization, type TestContext } from '@hanza/core/testing'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

const databaseUrl = inject('hanzaTestDatabaseUrl')
const user: Actor = { type: 'user', userId: 'user-1' }
const pln = (amount: string) => ({ amount, currency: 'PLN' })

describe.skipIf(!databaseUrl)('per-Offer push results and Offer publication end to end (real Postgres, in-memory queue, fake Channel)', () => {
  let ctx: TestContext
  let fake: FakeChannel
  let org: string
  let connectionId: string
  const products: Record<string, string> = {}

  beforeAll(async () => {
    fake = createFakeChannel()
    // The Channel refuses fake-offer-2's stock and price (a locked listing, say).
    fake.reject('fake-offer-2', 'OFFER_LOCKED')
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

  /** Every number the fake Channel was sent for this Offer, in order. */
  function sent(offerExternalId: string): number[] {
    return fake.stockPushes.flat().filter((level) => level.offerExternalId === offerExternalId).map((level) => level.available)
  }

  const offer = (externalId: string) => ctx.db.offer.findFirstOrThrow({ where: { organizationId: org, connectionId, externalId } })
  const health = async () => (await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId, organizationId: org } })).health
  const syncState = (stream: 'stock_push' | 'price_push') =>
    ctx.db.syncState.findFirstOrThrow({ where: { organizationId: org, connectionId, stream } })

  async function pushStockNow() {
    await ctx.queue.enqueue(stockPushRef, { organizationId: org, connectionId }, { coalesceKey: coalesceKeys.stockPush(connectionId) })
    await drain()
  }

  it('1. one rejected Offer in a batch of three leaves the other two pushed and the Connection ok', async () => {
    for (const sku of ['FAKE-SKU-1', 'FAKE-SKU-2', 'FAKE-SKU-3']) {
      products[sku] = (await createProduct(ctx, org, { sku, name: sku, stock: 5 }, user)).productId
    }
    connectionId = (
      await addConnection(ctx, org, { connectorId: 'fake', name: 'Fake', config: { failMode: 'none' }, credentials: { apiKey: 'test' } }, user)
    ).connectionId
    await drain()

    // One call carried all three Offers (fake-order-1 reserves 2 mugs).
    const batch = fake.stockPushes.find((levels) => levels.some((level) => level.offerExternalId === 'fake-offer-2'))
    expect(batch?.map((level) => level.offerExternalId).sort()).toEqual(['fake-offer-1', 'fake-offer-2', 'fake-offer-3'])
    expect(await health()).toBe('ok')
    expect(await syncState('stock_push')).toMatchObject({ lastErrorKind: null, lastResult: { pushed: 2, rejected: 1, skipped: 0 } })
    expect(await offer('fake-offer-1')).toMatchObject({ lastPushedAvailable: 3, stockRejectedCode: null })
    expect(await offer('fake-offer-3')).toMatchObject({ lastPushedAvailable: 5, stockRejectedCode: null })
    const rejected = await offer('fake-offer-2')
    expect(rejected).toMatchObject({ lastPushedAvailable: null, stockRejectedCode: 'OFFER_LOCKED', channelStatus: 'active' })
    expect(await getOffer(ctx, org, rejected.id)).toMatchObject({ stockStatus: 'rejected', stockRejection: { code: 'OFFER_LOCKED' } })
    const events = await ctx.db.eventLog.findMany({ where: { organizationId: org, type: 'offer.push_rejected' } })
    // fake-order-2 reserved and released a T-shirt, so fake-offer-2 was sent (and refused) again: once per change.
    expect(events.length).toBeGreaterThanOrEqual(1)
    for (const event of events) {
      expect([event.subjectType, event.subjectId, event.payload]).toEqual(['offer', rejected.id, { push: 'stock', code: 'OFFER_LOCKED' }])
    }
    expect(events.length).toBe(sent('fake-offer-2').length)
  })

  it('2. the rejected Offer is not pushed again until Retry, which then pushes it', async () => {
    const before = sent('fake-offer-2').length
    await pushStockNow()
    expect(sent('fake-offer-2')).toHaveLength(before)

    fake.reject('fake-offer-2', null)
    const { id } = await offer('fake-offer-2')
    await retryOfferPush(ctx, org, id, 'stock', user)
    await drain()
    expect(sent('fake-offer-2')).toHaveLength(before + 1)
    expect(await offer('fake-offer-2')).toMatchObject({ lastPushedAvailable: 5, stockRejectedCode: null, stockRejectedAt: null })
    expect(await getOffer(ctx, org, id)).toMatchObject({ stockStatus: 'pushed', stockRejection: null })
  })

  it('3. pushing 0 ends the Offer on the Channel and the status is stored', async () => {
    await setStock(ctx, org, products['FAKE-SKU-3']!, 0, user)
    await drain()
    expect(sent('fake-offer-3').at(-1)).toBe(0)
    expect(fake.offer('fake-offer-3')).toMatchObject({ status: 'ended', endedReason: 'sold_out' })
    expect(await offer('fake-offer-3')).toMatchObject({ channelStatus: 'ended', channelEndedReason: 'sold_out', lastPushedAvailable: 0 })
    expect(await getOffer(ctx, org, (await offer('fake-offer-3')).id)).toMatchObject({
      publication: { status: 'ended', endedReason: 'sold_out' },
    })
    expect(await health()).toBe('ok')

    // The next pull reports what the push did: no change, so no second Event.
    await requestSync(ctx, org, connectionId)
    await drain()
    const changes = await ctx.db.eventLog.findMany({ where: { organizationId: org, type: 'offer.channel_status_changed' } })
    expect(changes.map((event) => event.payload)).toEqual([{ from: 'active', to: 'ended', endedReason: 'sold_out', source: 'push' }])
  })

  it('4. raising the stock reopens the sold-out Offer', async () => {
    await setStock(ctx, org, products['FAKE-SKU-3']!, 4, user)
    await drain()
    expect(sent('fake-offer-3').at(-1)).toBe(4)
    expect(fake.offer('fake-offer-3')).toMatchObject({ status: 'active' })
    expect(await offer('fake-offer-3')).toMatchObject({ channelStatus: 'active', channelEndedReason: null, lastPushedAvailable: 4 })
  })

  it('5. an Offer the seller ended is reported rejected without a Channel call, and pushed once reactivated', async () => {
    fake.addOffer({ externalId: 'fake-offer-8', sku: 'FAKE-SKU-8', name: 'Ended by the seller', url: null, status: 'ended', endedReason: 'other' })
    products['FAKE-SKU-8'] = (await createProduct(ctx, org, { sku: 'FAKE-SKU-8', name: 'Eight', stock: 2 }, user)).productId
    await requestSync(ctx, org, connectionId)
    await drain()

    expect(sent('fake-offer-8')).toEqual([])
    const ended = await offer('fake-offer-8')
    expect(ended).toMatchObject({ productId: products['FAKE-SKU-8'], channelStatus: 'ended', channelEndedReason: 'other', stockRejectedCode: 'offer_ended' })
    expect(ended.stockPushedSeq).toBe(ended.stockPushSeq)
    expect(await health()).toBe('ok')

    // Raising its stock does not reopen it either.
    await setStock(ctx, org, products['FAKE-SKU-8']!, 6, user)
    await drain()
    expect(sent('fake-offer-8')).toEqual([])

    // The seller reactivates it on the Channel: the next pull re-marks it, and it gets its number.
    fake.addOffer({ externalId: 'fake-offer-8', sku: 'FAKE-SKU-8', name: 'Ended by the seller', url: null, status: 'active' })
    await requestSync(ctx, org, connectionId)
    await drain()
    expect(sent('fake-offer-8')).toEqual([6])
    expect(await offer('fake-offer-8')).toMatchObject({ channelStatus: 'active', stockRejectedCode: null, lastPushedAvailable: 6 })
  })

  it('6. a rejected price leaves the other prices pushed and the Connection ok, until Retry', async () => {
    fake.reject('fake-offer-1', 'PRICE_BELOW_MINIMUM')
    await setBasePrice(ctx, org, products['FAKE-SKU-1']!, pln('49.99'), user)
    await setBasePrice(ctx, org, products['FAKE-SKU-2']!, pln('69.00'), user)
    await drain()

    expect(await health()).toBe('ok')
    expect(await syncState('price_push')).toMatchObject({ lastErrorKind: null, lastResult: { pushed: 1, rejected: 1, skipped: 0 } })
    expect(fake.offer('fake-offer-2')?.price).toEqual(pln('69'))
    expect(fake.offer('fake-offer-1')?.price).toEqual(pln('39.99'))
    const mug = await offer('fake-offer-1')
    expect(await getOffer(ctx, org, mug.id)).toMatchObject({ priceStatus: 'rejected', priceRejection: { code: 'PRICE_BELOW_MINIMUM' } })

    const calls = fake.pricePushes.length
    fake.reject('fake-offer-1', null)
    await retryOfferPush(ctx, org, mug.id, 'price', user)
    await drain()
    expect(fake.pricePushes.slice(calls).flat().map((price) => price.offerExternalId)).toEqual(['fake-offer-1'])
    expect(fake.offer('fake-offer-1')?.price).toEqual(pln('49.99'))
    expect(await getOffer(ctx, org, mug.id)).toMatchObject({ priceStatus: 'pushed', priceRejection: null })
  })

  it('7. a Connection configured to refuse an Offer reports it with the fake code', async () => {
    const other = (
      await addConnection(
        ctx,
        org,
        { connectorId: 'fake', name: 'Refusing', config: { failMode: 'none', rejectOffers: 'fake-offer-1' }, credentials: { apiKey: 'test' } },
        user,
      )
    ).connectionId
    await drain()
    const refused = await ctx.db.offer.findFirstOrThrow({ where: { organizationId: org, connectionId: other, externalId: 'fake-offer-1' } })
    expect(refused).toMatchObject({ stockRejectedCode: FAKE_REJECTED_CODE })
    expect((await ctx.db.connection.findFirstOrThrow({ where: { id: other, organizationId: org } })).health).toBe('ok')
  })
})
