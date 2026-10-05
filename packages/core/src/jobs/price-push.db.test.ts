import { defineConnector, TransientError, type OfferPrice } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { upsertOffers } from '../catalog/offers'
import { createProduct, createProductsFromOffers, getProduct } from '../catalog/products'
import { createConnection } from '../connections/connections'
import { setBasePrice, setOfferPrice } from '../prices/set-price'
import { listOffersAwaitingPricePush, markOffersPriceHandled } from '../prices/push'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { uniqueSku, user } from '../testing/fixtures'
import { pricePushJob } from './price-push'

const pushes: OfferPrice[][] = []
let failNext = 0

const empty = async () => ({ items: [], nextCursor: null, hasMore: false })
const channel = defineConnector({
  id: 'price-push-channel',
  name: 'Price channel',
  kind: 'marketplace',
  auth: { type: 'none' },
  configSchema: z.object({}),
  credentialsSchema: z.object({}),
  capabilities: {
    'offers.pull': empty,
    'orders.pull': empty,
    async 'stock.push'() {},
    async 'price.push'(_ctx, prices) {
      if (failNext > 0) {
        failNext--
        throw new TransientError('503 Service Unavailable')
      }
      pushes.push(prices)
    },
  },
})
const noPrices = defineConnector({
  ...channel,
  id: 'price-push-plain',
  capabilities: { 'offers.pull': empty, 'orders.pull': empty, async 'stock.push'() {} },
})

const run = { attempt: 1, maxAttempts: 5, retriedLater: 0 }
const pln = (amount: string) => ({ amount, currency: 'PLN' })
const eur = (amount: string) => ({ amount, currency: 'EUR' })

describe.skipIf(!databaseUrl)('price.push', () => {
  const context = useTestContext({ connectors: [channel, noPrices] })

  async function setup(connectorId = 'price-push-channel') {
    const ctx = context()
    const organizationId = await createTestOrganization(ctx.db)
    const { connectionId } = await createConnection(ctx, organizationId, { connectorId, name: 'Channel', config: {}, credentials: {} }, user)
    const sku = uniqueSku()
    const { productId } = await createProduct(ctx, organizationId, { sku, name: 'Mug', stock: 1 }, user)
    await upsertOffers(
      ctx,
      organizationId,
      connectionId,
      [
        { externalId: 'pln', sku, name: 'PLN offer', url: null, price: pln('39.99') },
        { externalId: 'eur', sku, name: 'EUR offer', url: null, price: eur('9.99') },
        { externalId: 'unknown', sku, name: 'No price reported', url: null },
        { externalId: 'unlinked', sku: null, name: 'Unlinked', url: null, price: pln('1') },
      ],
      new Date(),
    )
    const offer = (externalId: string) => ctx.db.offer.findFirstOrThrow({ where: { organizationId, connectionId, externalId } })
    const state = () => ctx.db.syncState.findFirst({ where: { organizationId, connectionId, stream: 'price_push' } })
    const push = () => pricePushJob.handler(ctx, { organizationId, connectionId }, run)
    pushes.length = 0
    failNext = 0
    return { ctx, organizationId, connectionId, productId, offer, state, push }
  }

  it('with no price set it marks the linked Offers handled without calling the Channel', async () => {
    const { offer, state, push } = await setup()
    await push()
    expect(pushes).toEqual([])
    for (const id of ['pln', 'eur', 'unknown']) {
      const row = await offer(id)
      expect(row.pricePushedSeq).toBe(row.pricePushSeq)
      expect(row.lastPricePushedAt).toBeNull()
    }
    expect(await state()).toMatchObject({ lastResult: null, lastSucceededAt: null })
  })

  it('pushes the base price only where the Channel uses its currency, and skips the rest', async () => {
    const { ctx, organizationId, connectionId, productId, offer, state, push } = await setup()
    await setBasePrice(ctx, organizationId, productId, pln('49.90'), user)
    await push()

    expect(pushes).toEqual([[{ offerExternalId: 'pln', sku: (await offer('pln')).sku, price: pln('49.9') }]])
    expect(await offer('pln')).toMatchObject({ lastPushedPriceCurrency: 'PLN' })
    expect((await offer('pln')).lastPushedPriceAmount?.toFixed()).toBe('49.9')
    for (const id of ['eur', 'unknown']) {
      const row = await offer(id)
      expect([row.pricePushedSeq === row.pricePushSeq, row.lastPushedPriceAmount]).toEqual([true, null])
    }
    expect(await state()).toMatchObject({ lastResult: { pushed: 1, skipped: 2 }, lastErrorKind: null })
    expect((await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId } })).health).toBe('ok')

    pushes.length = 0
    await push()
    expect(pushes).toEqual([])
  })

  it('an override in the Channel\'s currency is pushed where the base price could not be', async () => {
    const { ctx, organizationId, productId, offer, push } = await setup()
    await setBasePrice(ctx, organizationId, productId, pln('49.90'), user)
    await push()
    pushes.length = 0

    await setOfferPrice(ctx, organizationId, (await offer('eur')).id, eur('11'), user)
    await push()
    expect(pushes).toEqual([[{ offerExternalId: 'eur', sku: (await offer('eur')).sku, price: eur('11') }]])
  })

  it('a failed push leaves the Offer pending; the next run pushes it', async () => {
    const { ctx, organizationId, productId, offer, state, push } = await setup()
    await setBasePrice(ctx, organizationId, productId, pln('20'), user)
    failNext = 1

    await expect(push()).rejects.toBeInstanceOf(TransientError)
    expect(pushes).toEqual([])
    const pending = await offer('pln')
    expect(pending.pricePushSeq).toBeGreaterThan(pending.pricePushedSeq)
    expect(await state()).toMatchObject({ lastErrorKind: 'transient', lastError: '503 Service Unavailable' })

    await push()
    expect(pushes.map((prices) => prices.map((price) => price.price))).toEqual([[pln('20')]])
    expect(await state()).toMatchObject({ lastErrorKind: null, lastResult: { pushed: 1 } })
  })

  it('compare-and-clear: a change made while a push ran keeps the Offer pending', async () => {
    const { ctx, organizationId, connectionId, productId, offer } = await setup()
    await setBasePrice(ctx, organizationId, productId, pln('20'), user)
    const listed = await listOffersAwaitingPricePush(ctx, organizationId, connectionId, 100)
    await setBasePrice(ctx, organizationId, productId, pln('21'), user)

    await markOffersPriceHandled(ctx, organizationId, listed.map((item) => ({ offerId: item.offerId, seq: item.seq, pushed: item.effective })))
    const row = await offer('pln')
    expect(row.pricePushSeq).toBeGreaterThan(row.pricePushedSeq)
  })

  it('creating a Product from one Channel\'s Offer pushes no price to any Channel until a person sets one', async () => {
    const ctx = context()
    const organizationId = await createTestOrganization(ctx.db)
    const connection = async (name: string) =>
      (await createConnection(ctx, organizationId, { connectorId: 'price-push-channel', name, config: {}, credentials: {} }, user)).connectionId
    const marketplace = await connection('Marketplace')
    const shop = await connection('Shop')
    const sku = uniqueSku()
    await upsertOffers(ctx, organizationId, marketplace, [{ externalId: 'm-1', sku, name: 'Mug', url: null, price: pln('39.99') }], new Date())
    await upsertOffers(ctx, organizationId, shop, [{ externalId: 's-1', sku, name: 'Mug', url: null, price: pln('25.00') }], new Date())
    const marketplaceOffer = await ctx.db.offer.findFirstOrThrow({ where: { organizationId, connectionId: marketplace } })
    const pushBoth = async () => {
      for (const connectionId of [marketplace, shop]) await pricePushJob.handler(ctx, { organizationId, connectionId }, run)
    }

    const { created } = await createProductsFromOffers(ctx, organizationId, [marketplaceOffer.id], user)
    const productId = created[0]!
    // The shop's Offer was linked by SKU too, so both are marked for a push...
    expect(await ctx.db.offer.count({ where: { organizationId, productId } })).toBe(2)
    pushes.length = 0
    await pushBoth()
    // ...but neither Channel receives the marketplace's price.
    expect(pushes).toEqual([])
    const product = await getProduct(ctx, organizationId, productId)
    expect(product?.basePrice).toBeNull()
    expect(product?.offers.map((offer) => [offer.externalId, offer.channelPrice, offer.priceStatus])).toEqual([
      ['m-1', pln('39.99'), 'no_price'],
      ['s-1', pln('25'), 'no_price'],
    ])

    await setBasePrice(ctx, organizationId, productId, pln('29.90'), user)
    await pushBoth()
    expect(pushes.flat().map((price) => [price.offerExternalId, price.price])).toEqual([
      ['m-1', pln('29.9')],
      ['s-1', pln('29.9')],
    ])
  })

  it('does nothing for a connector without price.push or for a payload naming another organization', async () => {
    const plain = await setup('price-push-plain')
    await setBasePrice(plain.ctx, plain.organizationId, plain.productId, pln('5'), user)
    await plain.push()
    expect(await plain.state()).toBeNull()

    const { ctx, organizationId, connectionId, productId, state } = await setup()
    await setBasePrice(ctx, organizationId, productId, pln('5'), user)
    const other = await createTestOrganization(ctx.db)
    await pricePushJob.handler(ctx, { organizationId: other, connectionId }, run)
    expect(pushes).toEqual([])
    expect(await state()).toBeNull()
  })
})
