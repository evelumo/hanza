import { defineConnector, type Offer } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { getOffer, linkOffer, upsertOffers } from '../catalog/offers'
import { createProduct, createProductsFromOffers, getProduct } from '../catalog/products'
import { createConnection } from '../connections/connections'
import { DomainError } from '../errors'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { uniqueSku, user } from '../testing/fixtures'
import { setBasePrice, setOfferPrice } from './set-price'

const empty = async () => ({ items: [], nextCursor: null, hasMore: false })
const pricedChannel = defineConnector({
  id: 'prices-channel',
  name: 'Priced channel',
  kind: 'shop',
  auth: { type: 'none' },
  configSchema: z.object({}),
  credentialsSchema: z.object({}),
  capabilities: { 'offers.pull': empty, 'orders.pull': empty, 'stock.push': async () => {}, 'price.push': async () => {} },
})
const plainChannel = defineConnector({
  ...pricedChannel,
  id: 'prices-plain',
  capabilities: { 'offers.pull': empty, 'orders.pull': empty, 'stock.push': async () => {} },
})

const pln = (amount: string) => ({ amount, currency: 'PLN' })
const eur = (amount: string) => ({ amount, currency: 'EUR' })

async function domainError(promise: Promise<unknown>): Promise<DomainError> {
  const error = await promise.then(() => null, (reason: unknown) => reason)
  expect(error).toBeInstanceOf(DomainError)
  return error as DomainError
}

describe.skipIf(!databaseUrl)('prices', () => {
  const context = useTestContext({ connectors: [pricedChannel, plainChannel] })

  async function setup(connectorId = 'prices-channel') {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const { connectionId } = await createConnection(ctx, org, { connectorId, name: 'Channel', config: {}, credentials: {} }, user)
    const sku = uniqueSku()
    const { productId } = await createProduct(ctx, org, { sku, name: 'Mug', stock: 1 }, user)
    const offers: Offer[] = [
      { externalId: 'linked', sku, name: 'Mug', url: null, price: pln('39.99') },
      { externalId: 'unlinked', sku: null, name: 'Other', url: null, price: pln('5') },
    ]
    await upsertOffers(ctx, org, connectionId, offers, new Date())
    const offer = (externalId: string) => ctx.db.offer.findFirstOrThrow({ where: { organizationId: org, connectionId, externalId } })
    ctx.queue.waiting.length = 0
    return { ctx, org, connectionId, sku, productId, offer }
  }

  const events = (ctx: ReturnType<typeof context>, org: string, type: string) =>
    ctx.db.eventLog.findMany({ where: { organizationId: org, type }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })

  it('stores the Channel price at pull and never adopts it as a base price', async () => {
    const { ctx, org, productId, offer } = await setup()
    expect(await offer('linked')).toMatchObject({ channelPriceCurrency: 'PLN', pricePushSeq: 1 })
    expect((await offer('linked')).channelPriceAmount?.toFixed()).toBe('39.99')
    expect((await getProduct(ctx, org, productId))?.basePrice).toBeNull()
  })

  it('setBasePrice records an Event, marks the linked Offers only and enqueues one coalesced price push', async () => {
    const { ctx, org, connectionId, productId, offer } = await setup()
    const before = { linked: (await offer('linked')).pricePushSeq, unlinked: (await offer('unlinked')).pricePushSeq }

    await setBasePrice(ctx, org, productId, pln('49.90'), user)

    expect((await getProduct(ctx, org, productId))?.basePrice).toEqual(pln('49.9'))
    expect((await offer('linked')).pricePushSeq).toBe(before.linked + 1)
    expect((await offer('unlinked')).pricePushSeq).toBe(before.unlinked)
    expect(ctx.queue.waiting).toEqual([
      { name: 'price.push', payload: { organizationId: org, connectionId }, options: { coalesceKey: `price.push:${connectionId}` } },
    ])
    expect((await events(ctx, org, 'product.price_changed')).map((event) => event.payload)).toEqual([
      { from: null, to: pln('49.9'), actor: user },
    ])
  })

  it('setBasePrice with the same price changes nothing; null clears it', async () => {
    const { ctx, org, productId, offer } = await setup()
    await setBasePrice(ctx, org, productId, pln('10.5'), user)
    const seq = (await offer('linked')).pricePushSeq
    ctx.queue.waiting.length = 0

    await setBasePrice(ctx, org, productId, pln('10.50'), user)
    expect((await offer('linked')).pricePushSeq).toBe(seq)
    expect(ctx.queue.waiting).toEqual([])

    await setBasePrice(ctx, org, productId, null, user)
    expect((await getProduct(ctx, org, productId))?.basePrice).toBeNull()
    expect((await offer('linked')).pricePushSeq).toBe(seq + 1)
    expect((await events(ctx, org, 'product.price_changed')).map((event) => event.payload)).toEqual([
      { from: null, to: pln('10.5'), actor: user },
      { from: pln('10.5'), to: null, actor: user },
    ])
  })

  it('rejects a zero, negative or malformed price before touching the database', async () => {
    const { ctx, org, productId } = await setup()
    for (const price of [pln('0'), pln('-1'), pln('1.23456'), { amount: '1', currency: 'zł' }]) {
      await expect(setBasePrice(ctx, org, productId, price, user)).rejects.toBeInstanceOf(RangeError)
    }
    expect(await events(ctx, org, 'product.price_changed')).toEqual([])
  })

  it('does not reach another organization\'s Product or Offer', async () => {
    const { ctx, productId, offer } = await setup()
    const other = await createTestOrganization(ctx.db)
    expect((await domainError(setBasePrice(ctx, other, productId, pln('1'), user))).code).toBe('not_found')
    expect((await domainError(setOfferPrice(ctx, other, (await offer('linked')).id, pln('1'), user))).code).toBe('not_found')
    expect(await getOffer(ctx, other, (await offer('linked')).id)).toBeNull()
  })

  it('setOfferPrice overrides one Offer; an unlinked Offer keeps its override but is not pushed', async () => {
    const { ctx, org, offer } = await setup()
    const linked = await offer('linked')
    await setOfferPrice(ctx, org, linked.id, eur('9.99'), user)
    expect((await offer('linked')).pricePushSeq).toBe(linked.pricePushSeq + 1)
    expect(ctx.queue.waiting.map((job) => job.name)).toEqual(['price.push'])
    expect((await getOffer(ctx, org, linked.id))?.priceOverride).toEqual(eur('9.99'))

    ctx.queue.waiting.length = 0
    const unlinked = await offer('unlinked')
    await setOfferPrice(ctx, org, unlinked.id, pln('3'), user)
    expect(ctx.queue.waiting).toEqual([])
    expect((await events(ctx, org, 'offer.price_changed')).map((event) => [event.subjectId, event.payload])).toEqual([
      [linked.id, { from: null, to: eur('9.99'), actor: user }],
      [unlinked.id, { from: null, to: pln('3'), actor: user }],
    ])
  })

  it('a pull marks a linked Offer for a price push when its Channel currency changes, not when only the amount does', async () => {
    const { ctx, org, connectionId, sku, offer } = await setup()
    const seq = (await offer('linked')).pricePushSeq
    const pull = (price: { amount: string; currency: string } | null) =>
      upsertOffers(ctx, org, connectionId, [{ externalId: 'linked', sku, name: 'Mug', url: null, price }], new Date())

    expect(await pull(pln('41'))).toMatchObject({ repriced: 0 })
    expect((await offer('linked')).pricePushSeq).toBe(seq)
    expect(await pull(eur('10'))).toMatchObject({ repriced: 1 })
    expect(await pull(null)).toMatchObject({ repriced: 1 })
    expect(await pull(null)).toMatchObject({ repriced: 0 })
    expect((await offer('linked')).pricePushSeq).toBe(seq + 2)
  })

  it('linking an Offer by hand marks it for a price push', async () => {
    const { ctx, org, productId, offer } = await setup()
    const unlinked = await offer('unlinked')
    await linkOffer(ctx, org, unlinked.id, productId, user)
    expect((await offer('unlinked')).pricePushSeq).toBe(unlinked.pricePushSeq + 1)
    expect(ctx.queue.waiting.map((job) => job.name)).toContain('price.push')
  })

  it('creating a Product from an Offer seeds its base price from the Channel price', async () => {
    const { ctx, org, connectionId } = await setup()
    const sku = uniqueSku('SEED')
    await upsertOffers(
      ctx,
      org,
      connectionId,
      [
        { externalId: 'seed', sku, name: 'Seed', url: null, price: pln('12.30') },
        { externalId: 'free', sku: `${sku}-FREE`, name: 'Free', url: null, price: pln('0') },
      ],
      new Date(),
    )
    const ids = await ctx.db.offer.findMany({ where: { organizationId: org, externalId: { in: ['seed', 'free'] } }, orderBy: { externalId: 'desc' } })
    const { created } = await createProductsFromOffers(ctx, org, ids.map((offer) => offer.id), user)
    const products = await Promise.all(created.map((id) => getProduct(ctx, org, id)))
    expect(products.map((product) => [product?.sku, product?.basePrice])).toEqual([
      [sku, pln('12.3')],
      [`${sku}-FREE`, null],
    ])
    expect(ctx.queue.waiting.map((job) => job.name)).toContain('price.push')
  })

  it('getProduct and getOffer say why a price is not pushed', async () => {
    const { ctx, org, productId, offer } = await setup()
    const status = async () => (await getProduct(ctx, org, productId))?.offers.map((item) => item.priceStatus)
    expect(await status()).toEqual(['no_price'])

    await setBasePrice(ctx, org, productId, pln('20'), user)
    expect(await status()).toEqual(['pending'])

    await setOfferPrice(ctx, org, (await offer('linked')).id, eur('5'), user)
    const detail = await getOffer(ctx, org, (await offer('linked')).id)
    expect(detail).toMatchObject({
      channelPrice: pln('39.99'),
      priceOverride: eur('5'),
      effectivePrice: eur('5'),
      priceStatus: 'currency_mismatch',
      product: { id: productId, basePrice: pln('20') },
    })
    expect((await getOffer(ctx, org, (await offer('unlinked')).id))?.priceStatus).toBe('not_linked')
  })

  it('an Offer of a connector without price.push is shown as unsupported', async () => {
    const { ctx, org, productId } = await setup('prices-plain')
    await setBasePrice(ctx, org, productId, pln('20'), user)
    expect((await getProduct(ctx, org, productId))?.offers.map((item) => item.priceStatus)).toEqual(['unsupported'])
  })
})
