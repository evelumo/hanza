import { defineConnector, PermanentError, TransientError } from '@hanza/connector-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { linkOffer, upsertOffers } from '../catalog/offers'
import { createProduct } from '../catalog/products'
import { createConnection } from '../connections/connections'
import { PermanentJobError, type JobRunInfo } from '../jobs'
import { changeOrderStatus } from '../orders/change-status'
import { importOrder } from '../orders/import'
import { getChannelAvailability } from '../stock/channel-available'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, orderLine, readOrderFeed, uniqueSku, user } from '../testing/fixtures'
import { ordersUpdateStatusJob } from './orders-update-status'
import { stockPushJob } from './stock-push'

// A status push that reached the Channel is followed by a stock push of the Order's Offers there (ADR 0023).

// A shop that keeps its own stock count, as WooCommerce does: it takes the number it is told, and puts the units
// of an order back itself when that order is cancelled.
const shop = {
  stock: new Map<string, number>(),
  /** What a cancelled order gives back, by order id. */
  holds: new Map<string, { offer: string; units: number }>(),
  cancelled: new Set<string>(),
}
let sendsRequest = true
let refuse: Error | null = null
/** The shop takes the next status, and the answer is lost on the way back. */
let loseNextAnswer = false

const channel = defineConnector({
  id: 'own-count-shop',
  name: 'Shop with its own count',
  kind: 'shop',
  auth: { type: 'none' },
  configSchema: z.object({}),
  credentialsSchema: z.object({}),
  capabilities: {
    async 'offers.pull'() {
      return { items: [], nextCursor: null, hasMore: false }
    },
    async 'orders.pull'() {
      return { items: [], nextCursor: null, hasMore: false }
    },
    async 'stock.push'(_ctx, levels) {
      for (const level of levels) shop.stock.set(level.offerExternalId, level.available)
    },
    async 'orders.updateStatus'(ctx, { orderExternalId, phase }) {
      if (refuse) throw refuse
      // Without a request: the shop has no equivalent of this status.
      if (!sendsRequest) return
      await ctx.fetch('https://shop.example.com/status', { method: 'POST' })
      const hold = shop.holds.get(orderExternalId)
      if (phase === 'cancelled' && hold && !shop.cancelled.has(orderExternalId)) {
        shop.cancelled.add(orderExternalId)
        shop.stock.set(hold.offer, (shop.stock.get(hold.offer) ?? 0) + hold.units)
      }
      if (loseNextAnswer) {
        loseNextAnswer = false
        throw new TransientError('The answer never arrived')
      }
    },
  },
})

const run: JobRunInfo = { attempt: 1, maxAttempts: 5, retriedLater: 0 }

describe.skipIf(!databaseUrl)('orders.updateStatus sends Stock again', () => {
  const context = useTestContext({ connectors: [channel] })

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    shop.stock.clear()
    shop.holds.clear()
    shop.cancelled.clear()
    sendsRequest = true
    refuse = null
    loseNextAnswer = false
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function connect(organizationId: string, name: string) {
    const ctx = context()
    const { connectionId } = await createConnection(ctx, organizationId, { connectorId: 'own-count-shop', name, config: {}, credentials: {} }, user)
    await readOrderFeed(ctx, organizationId, connectionId)
    return connectionId
  }

  /**
   * Two shops selling the same mug. Shop A also lists it a second time, lists a poster, and has an Offer its Order
   * names that a person later linked to the poster. One Order of a mug on shop A, moved to processing by a person.
   */
  async function setup() {
    const ctx = context()
    const organizationId = await createTestOrganization(ctx.db)
    const mugSku = uniqueSku('MUG')
    const posterSku = uniqueSku('POSTER')
    const mug = (await createProduct(ctx, organizationId, { sku: mugSku, name: 'Mug', stock: 50 }, user)).productId
    const poster = (await createProduct(ctx, organizationId, { sku: posterSku, name: 'Poster', stock: 8 }, user)).productId
    const a = await connect(organizationId, 'Shop A')
    const b = await connect(organizationId, 'Shop B')
    const offer = (externalId: string, sku: string | null) => ({ externalId, sku, name: externalId, url: null })
    await upsertOffers(ctx, organizationId, a, [offer('mug', mugSku), offer('mug-again', mugSku), offer('poster', posterSku), offer('renamed', null)], new Date())
    await upsertOffers(ctx, organizationId, b, [offer('mug', mugSku)], new Date())

    const order = buildOrder({
      externalId: 'order-1',
      lines: [orderLine('l1', { offerExternalId: 'mug', sku: mugSku }), orderLine('l2', { offerExternalId: 'renamed', sku: mugSku })],
    })
    const { orderId } = await importOrder(ctx, organizationId, a, order)
    // The line stays a mug; the Offer it was bought through now belongs to the poster.
    const renamed = await ctx.db.offer.findFirstOrThrow({ where: { organizationId, connectionId: a, externalId: 'renamed' } })
    await linkOffer(ctx, organizationId, renamed.id, poster, user)
    await changeOrderStatus(ctx, organizationId, orderId, 'processing', user)
    ctx.queue.waiting.splice(0)

    /** Push sequence per Offer, as `<shop>/<offer>`. */
    const sequences = async () => {
      const offers = await ctx.db.offer.findMany({ where: { organizationId }, select: { connectionId: true, externalId: true, stockPushSeq: true } })
      return Object.fromEntries(offers.map((row) => [`${row.connectionId === a ? 'a' : 'b'}/${row.externalId}`, row.stockPushSeq]))
    }
    const waiting = () => ctx.queue.waiting.map((job) => [job.name, (job.payload as { connectionId?: string }).connectionId])
    const pushStatus = () => ordersUpdateStatusJob.handler(ctx, { organizationId, orderId }, run)
    return { ctx, organizationId, orderId, a, b, mug, sequences, waiting, pushStatus }
  }

  it("a push that reached the Channel marks the Order's Offers on its own Connection, and asks for their push", async () => {
    const t = await setup()
    const before = await t.sequences()
    await t.pushStatus()

    expect(await t.sequences()).toEqual({
      ...before,
      // The mug's Offers on shop A, and the Offer a line names though it is linked to another Product now.
      'a/mug': before['a/mug']! + 1,
      'a/mug-again': before['a/mug-again']! + 1,
      'a/renamed': before['a/renamed']! + 1,
      // Not the poster's own Offer, and nothing on shop B: it was told no status, so its count did not move.
    })
    expect(t.waiting()).toEqual([['stock.push', t.a]])
  })

  it('a request that finds the push done already marks nothing more', async () => {
    const t = await setup()
    await t.pushStatus()
    const after = await t.sequences()
    t.ctx.queue.waiting.splice(0)
    await t.pushStatus()
    expect(await t.sequences()).toEqual(after)
    expect(t.waiting()).toEqual([])
  })

  it('a push the connector resolved without a request marks nothing: the Channel was told nothing', async () => {
    const t = await setup()
    const before = await t.sequences()
    sendsRequest = false
    await t.pushStatus()
    expect(await t.sequences()).toEqual(before)
    expect(t.waiting()).toEqual([])
  })

  it('a status the Channel refused marks nothing', async () => {
    const t = await setup()
    const before = await t.sequences()
    refuse = new PermanentError('Status not allowed')
    await expect(t.pushStatus()).rejects.toBeInstanceOf(PermanentJobError)
    expect(await t.sequences()).toEqual(before)
    expect(t.waiting()).toEqual([])
  })

  describe('cancelling an Order the shop had counted', () => {
    /** One mug of fifty sold on the shop, which counts 49 like Hanza; then a person cancels the Order in Hanza. */
    async function cancelled() {
      const ctx = context()
      const organizationId = await createTestOrganization(ctx.db)
      const sku = uniqueSku('MUG')
      const mug = (await createProduct(ctx, organizationId, { sku, name: 'Mug', stock: 50 }, user)).productId
      const connectionId = await connect(organizationId, 'Shop')
      await upsertOffers(ctx, organizationId, connectionId, [{ externalId: 'mug', sku, name: 'Mug', url: null }], new Date())
      const sold = buildOrder({ externalId: 'sold-1', lines: [orderLine('l1', { offerExternalId: 'mug', sku })] })
      const { orderId } = await importOrder(ctx, organizationId, connectionId, sold)
      shop.holds.set('sold-1', { offer: 'mug', units: 1 })
      ctx.queue.waiting.splice(0)
      await stockPushJob.handler(ctx, { organizationId, connectionId }, run)
      expect(shop.stock.get('mug')).toBe(49)

      await changeOrderStatus(ctx, organizationId, orderId, 'cancelled', user)
      expect(ctx.queue.waiting.map((job) => job.name)).toEqual(['stock.push', 'orders.updateStatus'])
      const drain = () => ctx.queue.drain(ctx, [stockPushJob, ordersUpdateStatusJob])
      const channelAvailable = async () => (await getChannelAvailability(ctx.db, organizationId, connectionId, [mug])).get(mug)
      const pending = () => ctx.db.offer.count({ where: { organizationId, connectionId, stockPushSeq: { gt: ctx.db.offer.fields.stockPushedSeq } } })
      return { ctx, drain, channelAvailable, pending }
    }

    it('the stock push first, then the status: the shop adds the unit on top of 50, and is told 50 again', async () => {
      const t = await cancelled()
      expect(await t.drain()).toEqual({ ran: 3, failed: [] })
      expect(await t.channelAvailable()).toBe(50)
      expect(shop.stock.get('mug')).toBe(50)
      expect(await t.pending()).toBe(0)
    })

    it('the status first, then the stock push: the same number', async () => {
      const t = await cancelled()
      t.ctx.queue.waiting.reverse()
      // The push the status asks for coalesces with the one already waiting.
      expect(await t.drain()).toEqual({ ran: 2, failed: [] })
      expect(shop.stock.get('mug')).toBe(50)
      expect(await t.pending()).toBe(0)
    })

    it('the shop took the status but its answer was lost: the retry tells it again, and then the number', async () => {
      const t = await cancelled()
      loseNextAnswer = true
      // The stock push, the status push twice, the stock push again.
      expect(await t.drain()).toEqual({ ran: 4, failed: [] })
      expect(shop.cancelled.has('sold-1')).toBe(true)
      expect(shop.stock.get('mug')).toBe(50)
      expect(await t.pending()).toBe(0)
    })
  })
})
