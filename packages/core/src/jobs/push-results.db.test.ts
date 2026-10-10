import { defineConnector, type OfferPrice, type PricePushResult, type StockLevel, type StockPushResult } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { retryOfferPush } from '../catalog/offer-push'
import { getOffer, upsertOffers } from '../catalog/offers'
import { createProduct } from '../catalog/products'
import { createConnection } from '../connections/connections'
import { PermanentJobError } from '../jobs'
import { setBasePrice } from '../prices/set-price'
import { setStock } from '../stock/set-stock'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { orderFeedCaughtUp, uniqueSku, user } from '../testing/fixtures'
import { pricePushJob } from './price-push'
import { stockPushJob } from './stock-push'

const stockCalls: StockLevel[][] = []
const priceCalls: OfferPrice[][] = []
/** What the next calls answer, by Offer external id; anything else is applied. */
const stockAnswers = new Map<string, StockPushResult>()
const priceAnswers = new Map<string, PricePushResult>()
let rawStockAnswer: unknown

const empty = async () => ({ items: [], nextCursor: null, hasMore: false })
const capabilities = {
  'offers.pull': empty,
  'orders.pull': empty,
  async 'stock.push'(_ctx: unknown, levels: StockLevel[]) {
    stockCalls.push(levels)
    if (rawStockAnswer !== undefined) return rawStockAnswer as StockPushResult[]
    return levels.flatMap((level) => stockAnswers.get(level.offerExternalId) ?? [])
  },
  async 'price.push'(_ctx: unknown, prices: OfferPrice[]) {
    priceCalls.push(prices)
    return prices.flatMap((price) => priceAnswers.get(price.offerExternalId) ?? [])
  },
}
const base = { kind: 'marketplace', auth: { type: 'none' }, configSchema: z.object({}), credentialsSchema: z.object({}), capabilities } as const
const reopening = defineConnector({ ...base, id: 'results-reopening', name: 'Reopening channel', reopensSoldOutOffers: true })
const plain = defineConnector({ ...base, id: 'results-plain', name: 'Plain channel' })

const run = { attempt: 1, maxAttempts: 5, retriedLater: 0 }
const pln = (amount: string) => ({ amount, currency: 'PLN' })

describe.skipIf(!databaseUrl)('per-Offer push results', () => {
  const context = useTestContext({ connectors: [reopening, plain] })

  async function setup(connectorId: string, offers: Array<{ id: string; status?: 'active' | 'inactive' | 'ended'; endedReason?: 'sold_out' | 'other' }>) {
    const ctx = context()
    const organizationId = await createTestOrganization(ctx.db)
    const { connectionId } = await createConnection(ctx, organizationId, { connectorId, name: 'Channel', config: {}, credentials: {} }, user)
    await orderFeedCaughtUp(ctx, organizationId, connectionId)
    const products: Record<string, string> = {}
    for (const offer of offers) {
      const sku = uniqueSku()
      products[offer.id] = (await createProduct(ctx, organizationId, { sku, name: offer.id, stock: 5 }, user)).productId
      await upsertOffers(
        ctx,
        organizationId,
        connectionId,
        [{ externalId: offer.id, sku, name: offer.id, url: null, price: pln('10'), status: offer.status, endedReason: offer.endedReason }],
        new Date(),
      )
    }
    stockCalls.length = 0
    priceCalls.length = 0
    stockAnswers.clear()
    priceAnswers.clear()
    rawStockAnswer = undefined
    const offerRow = (externalId: string) => ctx.db.offer.findFirstOrThrow({ where: { organizationId, connectionId, externalId } })
    const health = async () => (await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId, organizationId } })).health
    const events = (type: string) => ctx.db.eventLog.findMany({ where: { organizationId, type }, orderBy: { createdAt: 'asc' } })
    const pushStock = () => stockPushJob.handler(ctx, { organizationId, connectionId }, run)
    const pushPrices = () => pricePushJob.handler(ctx, { organizationId, connectionId }, run)
    const pushed = () => stockCalls.flat().map((level) => `${level.offerExternalId}=${level.available}`).sort()
    return { ctx, organizationId, connectionId, products, offerRow, health, events, pushStock, pushPrices, pushed }
  }

  it('a rejected Offer is recorded and handled, the rest of the batch is pushed and the Connection stays ok', async () => {
    const t = await setup('results-plain', [{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    stockAnswers.set('b', { offerExternalId: 'b', outcome: 'rejected', code: 'OFFER_NOT_FOUND' })
    await t.pushStock()

    expect(t.pushed()).toEqual(['a=5', 'b=5', 'c=5'])
    expect(await t.health()).toBe('ok')
    expect((await t.ctx.db.syncState.findFirstOrThrow({ where: { connectionId: t.connectionId, stream: 'stock_push' } })).lastResult).toEqual({
      pushed: 2,
      rejected: 1,
      skipped: 0,
    })
    const b = await t.offerRow('b')
    expect(b).toMatchObject({ stockRejectedCode: 'OFFER_NOT_FOUND', lastPushedAvailable: null })
    expect(b.stockPushedSeq).toBe(b.stockPushSeq)
    expect(await t.offerRow('a')).toMatchObject({ stockRejectedCode: null, lastPushedAvailable: 5 })
    expect((await t.events('offer.push_rejected')).map((event) => event.payload)).toEqual([{ push: 'stock', code: 'OFFER_NOT_FOUND' }])
    expect(await getOffer(t.ctx, t.organizationId, b.id)).toMatchObject({ stockStatus: 'rejected', stockRejection: { code: 'OFFER_NOT_FOUND' } })

    // Handled: the next run (event or sweep) does not send it again.
    stockCalls.length = 0
    await t.pushStock()
    expect(stockCalls).toEqual([])

    // Retry sends it again; this time the Channel takes it and the rejection is gone.
    stockAnswers.clear()
    await retryOfferPush(t.ctx, t.organizationId, b.id, 'stock', user)
    expect(await getOffer(t.ctx, t.organizationId, b.id)).toMatchObject({ stockStatus: 'pending', stockRejection: null })
    await t.pushStock()
    expect(t.pushed()).toEqual(['b=5'])
    expect(await t.offerRow('b')).toMatchObject({ stockRejectedCode: null, stockRejectedAt: null, lastPushedAvailable: 5 })
    expect((await t.events('offer.push_retried')).map((event) => event.payload)).toEqual([{ push: 'stock', actor: user }])
  })

  it('a change of Stock retries a rejected Offer on its own', async () => {
    const t = await setup('results-plain', [{ id: 'a' }])
    stockAnswers.set('a', { offerExternalId: 'a', outcome: 'rejected', code: 'LOCKED' })
    await t.pushStock()
    stockCalls.length = 0
    await setStock(t.ctx, t.organizationId, t.products.a!, 7, user)
    await t.pushStock()
    expect(t.pushed()).toEqual(['a=7'])
    expect(await t.offerRow('a')).toMatchObject({ stockRejectedCode: 'LOCKED' })
  })

  it('pushing 0 ends the Offer; a sold-out Offer is reopened only through a connector that reopens', async () => {
    const t = await setup('results-reopening', [{ id: 'a', status: 'active' }])
    stockAnswers.set('a', { offerExternalId: 'a', outcome: 'ended' })
    await setStock(t.ctx, t.organizationId, t.products.a!, 0, user)
    await t.pushStock()
    expect(t.pushed()).toEqual(['a=0'])
    expect(await t.offerRow('a')).toMatchObject({ channelStatus: 'ended', channelEndedReason: 'sold_out', lastPushedAvailable: 0 })
    expect((await t.events('offer.channel_status_changed')).map((event) => event.payload)).toEqual([
      { from: 'active', to: 'ended', endedReason: 'sold_out', source: 'push' },
    ])

    stockAnswers.clear()
    stockCalls.length = 0
    await setStock(t.ctx, t.organizationId, t.products.a!, 3, user)
    await t.pushStock()
    expect(t.pushed()).toEqual(['a=3'])
    expect(await t.offerRow('a')).toMatchObject({ channelStatus: 'active', channelEndedReason: null, lastPushedAvailable: 3 })
  })

  it('an Offer ended by the seller is rejected without a Channel call; 0 to an ended Offer is not sent', async () => {
    const t = await setup('results-reopening', [{ id: 'by-seller', status: 'ended', endedReason: 'other' }, { id: 'sold-out', status: 'ended', endedReason: 'sold_out' }])
    await setStock(t.ctx, t.organizationId, t.products['sold-out']!, 0, user)
    await t.pushStock()

    expect(stockCalls).toEqual([])
    expect(await t.offerRow('by-seller')).toMatchObject({ stockRejectedCode: 'offer_ended', channelStatus: 'ended' })
    expect(await t.offerRow('sold-out')).toMatchObject({ stockRejectedCode: null, lastPushedAt: null })
    expect((await t.offerRow('sold-out')).stockPushedSeq).toBe((await t.offerRow('sold-out')).stockPushSeq)
    // Nothing reached the Channel, so the run proves nothing about the Connection.
    expect(await t.health()).toBe('unknown')
  })

  it("Hanza's own offer_ended is recorded as one Event, not again on every change of Stock", async () => {
    const t = await setup('results-reopening', [{ id: 'by-seller', status: 'ended', endedReason: 'other' }])
    await t.pushStock()
    for (const units of [6, 7, 8]) {
      await setStock(t.ctx, t.organizationId, t.products['by-seller']!, units, user)
      await t.pushStock()
    }
    expect(stockCalls).toEqual([])
    expect(await t.events('offer.push_rejected')).toHaveLength(1)
    const offer = await t.offerRow('by-seller')
    expect(offer).toMatchObject({ stockRejectedCode: 'offer_ended' })
    expect(offer.stockPushedSeq).toBe(offer.stockPushSeq)
  })

  it('the database refuses an ended reason without an ended publication, and a code without its time', async () => {
    const t = await setup('results-plain', [{ id: 'a' }])
    const { id } = await t.offerRow('a')
    const set = (columns: string) => t.ctx.db.$executeRawUnsafe(`UPDATE "offer" SET ${columns} WHERE "id" = $1 AND "organizationId" = $2`, id, t.organizationId)
    await expect(set(`"channelStatus" = NULL, "channelEndedReason" = 'sold_out'`)).rejects.toThrow(/offer_channel_ended_reason_check/)
    await expect(set(`"channelStatus" = 'active', "channelEndedReason" = 'sold_out'`)).rejects.toThrow(/offer_channel_ended_reason_check/)
    await expect(set(`"stockRejectedCode" = 'X'`)).rejects.toThrow(/offer_stock_rejected_check/)
    await expect(set(`"priceRejectedAt" = now()`)).rejects.toThrow(/offer_price_rejected_check/)
    await expect(set(`"channelStatus" = 'ended', "channelEndedReason" = 'sold_out'`)).resolves.toBe(1)
  })

  it('a sold-out Offer is rejected when the connector does not reopen Offers', async () => {
    const t = await setup('results-plain', [{ id: 'a', status: 'ended', endedReason: 'sold_out' }, { id: 'b', status: 'inactive' }])
    await t.pushStock()
    expect(t.pushed()).toEqual(['b=5'])
    expect(await t.offerRow('a')).toMatchObject({ stockRejectedCode: 'offer_ended' })
  })

  it('a reported publication change re-marks a linked Offer for a stock push', async () => {
    const t = await setup('results-plain', [{ id: 'a', status: 'ended', endedReason: 'other' }])
    await t.pushStock()
    expect(await t.offerRow('a')).toMatchObject({ stockRejectedCode: 'offer_ended' })

    // The seller reactivated it in the Channel's own panel.
    const { sku } = await t.offerRow('a')
    const counts = await upsertOffers(t.ctx, t.organizationId, t.connectionId, [{ externalId: 'a', sku, name: 'a', url: null, status: 'active' }], new Date())
    expect(counts.republished).toBe(1)
    await t.pushStock()
    expect(t.pushed()).toEqual(['a=5'])
    expect(await t.offerRow('a')).toMatchObject({ channelStatus: 'active', stockRejectedCode: null })

    // A connector that stops reporting the status leaves it as it was.
    await upsertOffers(t.ctx, t.organizationId, t.connectionId, [{ externalId: 'a', sku, name: 'a', url: null }], new Date())
    expect(await t.offerRow('a')).toMatchObject({ channelStatus: 'active' })
  })

  it('results that break the contract fail the run as permanent', async () => {
    const t = await setup('results-plain', [{ id: 'a' }])
    rawStockAnswer = [{ offerExternalId: 'somebody-else', outcome: 'ok' }]
    await expect(t.pushStock()).rejects.toBeInstanceOf(PermanentJobError)
    expect(await t.health()).toBe('failing')
    const a = await t.offerRow('a')
    expect(a.stockPushSeq).toBeGreaterThan(a.stockPushedSeq)
  })

  it('a rejected price is recorded and handled, the others are pushed, and Retry sends it again', async () => {
    const t = await setup('results-plain', [{ id: 'a' }, { id: 'b' }])
    for (const id of ['a', 'b']) await setBasePrice(t.ctx, t.organizationId, t.products[id]!, pln('20'), user)
    priceAnswers.set('a', { offerExternalId: 'a', outcome: 'rejected', code: 'PRICE_BELOW_MINIMUM' })
    await t.pushPrices()

    expect(priceCalls.flat().map((price) => price.offerExternalId).sort()).toEqual(['a', 'b'])
    expect(await t.health()).toBe('ok')
    const a = await t.offerRow('a')
    expect(a).toMatchObject({ priceRejectedCode: 'PRICE_BELOW_MINIMUM', lastPushedPriceAmount: null })
    expect(a.pricePushedSeq).toBe(a.pricePushSeq)
    expect((await t.offerRow('b')).lastPushedPriceAmount?.toFixed()).toBe('20')
    expect(await getOffer(t.ctx, t.organizationId, a.id)).toMatchObject({
      priceStatus: 'rejected',
      priceRejection: { code: 'PRICE_BELOW_MINIMUM' },
    })
    expect((await t.ctx.db.syncState.findFirstOrThrow({ where: { connectionId: t.connectionId, stream: 'price_push' } })).lastResult).toEqual({
      pushed: 1,
      rejected: 1,
      skipped: 0,
    })

    priceCalls.length = 0
    await t.pushPrices()
    expect(priceCalls).toEqual([])

    priceAnswers.clear()
    await retryOfferPush(t.ctx, t.organizationId, a.id, 'price', user)
    await t.pushPrices()
    expect(priceCalls.flat().map((price) => price.offerExternalId)).toEqual(['a'])
    expect(await getOffer(t.ctx, t.organizationId, a.id)).toMatchObject({ priceStatus: 'pushed', priceRejection: null })
  })

  it('Retry refuses an Offer of another organization and an unlinked Offer', async () => {
    const t = await setup('results-plain', [{ id: 'a' }])
    const other = await createTestOrganization(t.ctx.db)
    const { id } = await t.offerRow('a')
    await expect(retryOfferPush(t.ctx, other, id, 'stock', user)).rejects.toMatchObject({ code: 'not_found' })
    await upsertOffers(t.ctx, t.organizationId, t.connectionId, [{ externalId: 'loose', sku: null, name: 'Loose', url: null }], new Date())
    const loose = await t.offerRow('loose')
    await expect(retryOfferPush(t.ctx, t.organizationId, loose.id, 'stock', user)).rejects.toMatchObject({ code: 'not_linked' })
  })
})
