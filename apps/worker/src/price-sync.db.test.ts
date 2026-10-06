import { createFakeChannel, type FakeChannel } from '@hanza/connector-fake'
import {
  addConnection,
  createProduct,
  getProduct,
  jobs,
  setBasePrice,
  setOfferPrice,
  SYNC_INTERVALS_MS,
  syncTickRef,
  type Actor,
  type ProductDetail,
} from '@hanza/core'
import { createTestContext, createTestOrganization, type TestContext } from '@hanza/core/testing'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

const databaseUrl = inject('hanzaTestDatabaseUrl')
const user: Actor = { type: 'user', userId: 'user-1' }
const pln = (amount: string) => ({ amount, currency: 'PLN' })
const eur = (amount: string) => ({ amount, currency: 'EUR' })

describe.skipIf(!databaseUrl)('price sync end to end (real Postgres, in-memory queue, fake Channel)', () => {
  let ctx: TestContext
  let fake: FakeChannel
  let org: string
  let connectionId: string
  let productId: string

  beforeAll(async () => {
    fake = createFakeChannel()
    // Two more Offers of the same Product on the Channel: one sold in PLN, one in EUR.
    fake.addOffer({ externalId: 'fake-offer-6', sku: 'FAKE-SKU-1', name: 'Ceramic mug, gift box', url: null, price: pln('44.99') })
    fake.addOffer({ externalId: 'fake-offer-7', sku: 'FAKE-SKU-1', name: 'Ceramic mug (EU)', url: null, price: eur('9.99') })
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

  /** The price the fake Channel last received for each Offer, by external id. */
  function lastPushedPrices(): Record<string, { amount: string; currency: string }> {
    const prices: Record<string, { amount: string; currency: string }> = {}
    for (const batch of fake.pricePushes) for (const item of batch) prices[item.offerExternalId] = item.price
    return prices
  }

  async function offers(): Promise<Record<string, ProductDetail['offers'][number]>> {
    const product = await getProduct(ctx, org, productId)
    return Object.fromEntries(product!.offers.map((offer) => [offer.externalId, offer]))
  }

  async function offerId(externalId: string): Promise<string> {
    return (await ctx.db.offer.findFirstOrThrow({ where: { organizationId: org, connectionId, externalId } })).id
  }

  /**
   * Runs one `sync.tick` and keeps only the jobs it enqueued for this Connection: the tick reads every
   * Connection, and the test database is shared with other test files whose credentials this context cannot open.
   */
  async function tick(): Promise<string[]> {
    await ctx.queue.enqueue(syncTickRef, {})
    expect(await ctx.queue.drain(ctx, jobs, { maxJobs: 1 })).toEqual({ ran: 1, failed: [] })
    const own = ctx.queue.waiting.filter((job) => (job.payload as { connectionId?: string }).connectionId === connectionId)
    ctx.queue.waiting.splice(0, ctx.queue.waiting.length, ...own)
    return own.map((job) => job.name)
  }

  async function priceSyncState() {
    return ctx.db.syncState.findFirstOrThrow({ where: { organizationId: org, connectionId, stream: 'price_push' } })
  }

  it('1. links three Offers to one Product and pushes no price while the Product has none', async () => {
    productId = (await createProduct(ctx, org, { sku: 'FAKE-SKU-1', name: 'Ceramic mug', stock: 5 }, user)).productId
    connectionId = (
      await addConnection(ctx, org, { connectorId: 'fake', name: 'Test channel', config: { failMode: 'none' }, credentials: { apiKey: 'test' } }, user)
    ).connectionId
    await drain()

    const linked = await offers()
    expect(Object.keys(linked).sort()).toEqual(['fake-offer-1', 'fake-offer-6', 'fake-offer-7'])
    expect(Object.values(linked).map((offer) => offer.priceStatus)).toEqual(['no_price', 'no_price', 'no_price'])
    expect(linked['fake-offer-7']?.channelPrice).toEqual(eur('9.99'))
    expect(fake.pricePushes).toEqual([])
    // The Channel's own price is never adopted as the base price.
    expect((await getProduct(ctx, org, productId))?.basePrice).toBeNull()
  })

  it('2. setting a base price pushes it to every Offer of the Product the Channel sells in that currency', async () => {
    await setBasePrice(ctx, org, productId, pln('45.00'), user)
    await drain()

    expect(lastPushedPrices()).toEqual({ 'fake-offer-1': pln('45'), 'fake-offer-6': pln('45') })
    const linked = await offers()
    expect(linked['fake-offer-1']).toMatchObject({ effectivePrice: pln('45'), lastPushedPrice: pln('45'), priceStatus: 'pushed' })
    expect(linked['fake-offer-6']).toMatchObject({ effectivePrice: pln('45'), lastPushedPrice: pln('45'), priceStatus: 'pushed' })
  })

  it('3. a currency mismatch is not pushed and is visible on the Product and in the sync result', async () => {
    const eu = (await offers())['fake-offer-7']
    expect(eu).toMatchObject({ effectivePrice: pln('45'), channelPrice: eur('9.99'), lastPushedPrice: null, priceStatus: 'currency_mismatch' })
    expect(lastPushedPrices()['fake-offer-7']).toBeUndefined()
    expect((await priceSyncState()).lastResult).toEqual({ pushed: 2, skipped: 1 })
  })

  it('4. an Offer override wins over the base price', async () => {
    const before = fake.pricePushes.length
    await setOfferPrice(ctx, org, await offerId('fake-offer-6'), pln('39.00'), user)
    await drain()

    expect(fake.pricePushes.slice(before)).toEqual([[{ offerExternalId: 'fake-offer-6', sku: 'FAKE-SKU-1', price: pln('39') }]])
    expect((await offers())['fake-offer-6']).toMatchObject({ priceOverride: pln('39'), effectivePrice: pln('39'), priceStatus: 'pushed' })
  })

  it('5. clearing the override falls back to the base price', async () => {
    await setOfferPrice(ctx, org, await offerId('fake-offer-6'), null, user)
    await drain()

    expect(lastPushedPrices()['fake-offer-6']).toEqual(pln('45'))
    expect((await offers())['fake-offer-6']).toMatchObject({ priceOverride: null, effectivePrice: pln('45'), priceStatus: 'pushed' })
  })

  it('6. an override in the Channel\'s currency resolves the mismatch', async () => {
    await setOfferPrice(ctx, org, await offerId('fake-offer-7'), eur('10.50'), user)
    await drain()

    expect(lastPushedPrices()['fake-offer-7']).toEqual(eur('10.5'))
    expect((await offers())['fake-offer-7']).toMatchObject({ priceStatus: 'pushed' })
  })

  it('7. a failed push is retried and succeeds once the Channel answers again', async () => {
    await ctx.db.connection.update({ where: { id: connectionId }, data: { config: { failMode: 'transient' } } })
    await setBasePrice(ctx, org, productId, pln('47.00'), user)
    const before = fake.pricePushes.length

    const first = await ctx.queue.drain(ctx, jobs, { maxJobs: 1 })
    expect(first).toEqual({ ran: 1, failed: [] })
    expect(ctx.queue.waiting.map((job) => job.name)).toEqual(['price.push'])
    expect(await priceSyncState()).toMatchObject({ lastErrorKind: 'transient' })
    expect((await offers())['fake-offer-1']?.priceStatus).toBe('pending')

    await ctx.db.connection.update({ where: { id: connectionId }, data: { config: { failMode: 'none' } } })
    await drain()
    expect(fake.pricePushes.length).toBe(before + 1)
    expect(lastPushedPrices()).toMatchObject({ 'fake-offer-1': pln('47'), 'fake-offer-6': pln('47') })
    expect(await priceSyncState()).toMatchObject({ lastErrorKind: null })
  })

  it('8. a push that fails every attempt is caught up by the scheduler\'s sweep', async () => {
    await ctx.db.connection.update({ where: { id: connectionId }, data: { config: { failMode: 'transient' } } })
    await setBasePrice(ctx, org, productId, pln('48.00'), user)
    const failed = await ctx.queue.drain(ctx, jobs)
    expect(failed.failed).toMatchObject([{ name: 'price.push', attempts: 5 }])
    expect((await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId } })).health).toBe('failing')
    expect(lastPushedPrices()['fake-offer-1']).toEqual(pln('47'))
    expect((await offers())['fake-offer-1']?.priceStatus).toBe('pending')

    // The Channel recovers; nothing is enqueued until the sweep, due once the interval has passed.
    await ctx.db.connection.update({ where: { id: connectionId }, data: { config: { failMode: 'none' } } })
    await ctx.db.syncState.updateMany({
      where: { organizationId: org, connectionId, stream: 'price_push' },
      data: { lastStartedAt: new Date(Date.now() - SYNC_INTERVALS_MS.price_push) },
    })
    expect(await tick()).toEqual(['price.push'])
    await drain()

    expect(lastPushedPrices()).toMatchObject({ 'fake-offer-1': pln('48'), 'fake-offer-6': pln('48') })
    expect((await offers())['fake-offer-1']?.priceStatus).toBe('pushed')
    expect((await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId } })).health).toBe('ok')
  })

  it('9. a price changed on the Channel is recorded at the next pull but never adopted', async () => {
    fake.addOffer({ externalId: 'fake-offer-1', sku: 'FAKE-SKU-1', name: 'Ceramic mug', url: null, price: pln('99.00') })
    const before = fake.pricePushes.length
    await ctx.db.syncState.updateMany({ where: { organizationId: org, connectionId, stream: 'offers_pull' }, data: { lastStartedAt: new Date(0) } })
    expect(await tick()).toEqual(['offers.pull'])
    await drain()

    const linked = await offers()
    expect(linked['fake-offer-1']).toMatchObject({ channelPrice: pln('99'), effectivePrice: pln('48') })
    // What Hanza pushed earlier is what the Channel reports now.
    expect(linked['fake-offer-7']?.channelPrice).toEqual(eur('10.5'))
    expect((await getProduct(ctx, org, productId))?.basePrice).toEqual(pln('48'))
    // Same currency, so nothing to push until Hanza's price changes (ADR 0011).
    expect(fake.pricePushes.length).toBe(before)
  })
})
