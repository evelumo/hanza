import { CursorExpiredError, defineConnector, type Order, type OfferPrice, type PullResult, type StockLevel } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { upsertOffers } from '../catalog/offers'
import { createProduct } from '../catalog/products'
import { createConnection } from '../connections/connections'
import { ordersPullJob } from '../jobs/orders-pull'
import { pricePushJob } from '../jobs/price-push'
import { stockPushJob } from '../jobs/stock-push'
import { setBasePrice } from '../prices/set-price'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, orderLine, uniqueSku, user } from '../testing/fixtures'
import { requestSync } from './requests'

type Pull = (cursor: string | null) => Promise<PullResult<Order>>
let pull: Pull = async () => ({ items: [], nextCursor: null, hasMore: false })
const stockCalls: StockLevel[][] = []
const priceCalls: OfferPrice[][] = []

const channel = defineConnector({
  id: 'hold-channel',
  name: 'Hold channel',
  kind: 'marketplace',
  auth: { type: 'none' },
  configSchema: z.object({}),
  credentialsSchema: z.object({}),
  capabilities: {
    async 'offers.pull'() {
      return { items: [], nextCursor: null, hasMore: false }
    },
    async 'orders.pull'(_ctx, cursor) {
      return pull(cursor)
    },
    async 'stock.push'(_ctx, levels) {
      stockCalls.push(levels)
    },
    async 'price.push'(_ctx, prices) {
      priceCalls.push(prices)
    },
  },
})

const run = { attempt: 1, maxAttempts: 5, retriedLater: 0 }
const pln = (amount: string) => ({ amount, currency: 'PLN' })

/** A listing of open Orders longer than one run: `orders` on its first page, then empty pages with more to come. */
function listing(orders: Order[]): Pull {
  return async (cursor) => {
    const page = cursor === null ? 0 : Number(cursor.slice(1))
    return { items: page === 0 ? orders : [], nextCursor: `l${page + 1}`, hasMore: true }
  }
}

describe.skipIf(!databaseUrl)('the stock push waits for the Order feed (#125)', () => {
  const context = useTestContext({ connectors: [channel] })

  /** A new Connection with one linked Offer of a Product with 10 units on the shelf. */
  async function setup() {
    const ctx = context()
    const organizationId = await createTestOrganization(ctx.db)
    const { connectionId } = await createConnection(
      ctx,
      organizationId,
      { connectorId: 'hold-channel', name: 'Channel', config: {}, credentials: {} },
      user,
    )
    const sku = uniqueSku()
    const { productId } = await createProduct(ctx, organizationId, { sku, name: 'Mug', stock: 10 }, user)
    await upsertOffers(ctx, organizationId, connectionId, [{ externalId: 'offer-1', sku, name: 'Mug', url: null, price: pln('10') }], new Date())
    pull = async () => ({ items: [], nextCursor: null, hasMore: false })
    stockCalls.length = 0
    priceCalls.length = 0
    const waiting = () =>
      ctx.queue.waiting.filter((job) => (job.payload as { connectionId?: string }).connectionId === connectionId).map((job) => job.name)
    const clearQueue = () => ctx.queue.waiting.splice(0)
    const pullOrders = () => ordersPullJob.handler(ctx, { organizationId, connectionId, trigger: 'schedule' }, run)
    const pushStock = () => stockPushJob.handler(ctx, { organizationId, connectionId }, run)
    const pushed = () => stockCalls.flat().map((level) => level.available)
    const state = (stream: 'orders_pull' | 'stock_push') => ctx.db.syncState.findFirst({ where: { organizationId, connectionId, stream } })
    const order = (externalId: string, quantity: number) => buildOrder({ externalId, lines: [orderLine('l1', { sku, quantity })] })
    return { ctx, organizationId, connectionId, productId, waiting, clearQueue, pullOrders, pushStock, pushed, state, order }
  }

  it('holds the push of a new Connection, without calling the Channel, until an Orders pull reads the feed to its end', async () => {
    const t = await setup()
    await t.pushStock()
    expect(stockCalls).toEqual([])
    // Only the start and the end are recorded: the tick waits its interval, the panel shows the stream, nothing failed.
    const held = await t.state('stock_push')
    expect(held).toMatchObject({ lastSucceededAt: null, lastResult: null, lastErrorKind: null })
    expect(held!.lastStartedAt).not.toBeNull()
    expect(held!.lastFinishedAt).toEqual(held!.lastStartedAt)
    const offer = await t.ctx.db.offer.findFirstOrThrow({ where: { organizationId: t.organizationId, connectionId: t.connectionId } })
    expect(offer.stockPushedSeq).toBeLessThan(offer.stockPushSeq)
    expect((await t.ctx.db.connection.findFirstOrThrow({ where: { id: t.connectionId } })).health).toBe('unknown')

    // The listing is longer than one run (its page limit): the run that stops with more to read leaves the push held.
    t.clearQueue()
    pull = listing([t.order('open-1', 2)])
    await t.pullOrders()
    expect(t.waiting()).toContain('orders.pull')
    expect((await t.state('orders_pull'))?.caughtUpAt).toBeNull()
    await t.pushStock()
    expect(stockCalls).toEqual([])
  })

  it('the Orders pull that catches up enqueues the push once, and the first number sent is net of the open Orders', async () => {
    const t = await setup()
    await t.pushStock()
    pull = listing([t.order('open-1', 2), t.order('open-2', 1)])
    await t.pullOrders()
    // The run that reaches the end imports nothing itself, so the push it leaves is its own, not an import's.
    t.clearQueue()
    pull = async () => ({ items: [], nextCursor: 'e1', hasMore: false })
    await t.pullOrders()
    expect((await t.state('orders_pull'))?.caughtUpAt).not.toBeNull()
    expect(t.waiting()).toEqual(['stock.push'])

    await t.pushStock()
    expect(t.pushed()).toEqual([7])

    // Later runs that catch up again do not ask for another push of their own.
    t.clearQueue()
    pull = async () => ({ items: [], nextCursor: 'e1', hasMore: false })
    await t.pullOrders()
    expect(t.waiting()).toEqual([])
  })

  it('a feed restart holds the push again until the restarted feed has caught up', async () => {
    const t = await setup()
    await t.pullOrders()
    await t.pushStock()
    expect(t.pushed()).toEqual([10])

    // The Channel no longer has the position; the restarted listing does not finish in this run.
    await t.ctx.db.syncState.updateMany({ where: { connectionId: t.connectionId, stream: 'orders_pull' }, data: { cursor: 'e-old' } })
    const restarted = listing([t.order('open-again', 4)])
    pull = async (cursor) => {
      if (cursor === 'e-old') throw new CursorExpiredError('gone')
      return restarted(cursor)
    }
    t.clearQueue()
    await t.pullOrders()
    expect(await t.ctx.db.eventLog.count({ where: { organizationId: t.organizationId, type: 'connection.order_feed_restarted' } })).toBe(1)
    expect((await t.state('orders_pull'))?.caughtUpAt).toBeNull()

    // The Reservation of the Order imported meanwhile waits with the push.
    stockCalls.length = 0
    await t.pushStock()
    expect(stockCalls).toEqual([])

    pull = async () => ({ items: [], nextCursor: 'e2', hasMore: false })
    t.clearQueue()
    await t.pullOrders()
    expect(t.waiting()).toEqual(['stock.push'])
    await t.pushStock()
    expect(t.pushed()).toEqual([6])
  })

  it('does not hold the price push', async () => {
    const t = await setup()
    await setBasePrice(t.ctx, t.organizationId, t.productId, pln('25'), user)
    await pricePushJob.handler(t.ctx, { organizationId: t.organizationId, connectionId: t.connectionId }, run)
    expect(priceCalls.flat().map((price) => price.price)).toEqual([pln('25')])
    await t.pushStock()
    expect(stockCalls).toEqual([])
  })

  it('"Synchronise now" on a Connection that never read its Orders leaves the stock push to the Orders pull', async () => {
    const t = await setup()
    t.clearQueue()
    await requestSync(t.ctx, t.organizationId, t.connectionId)
    expect(t.waiting()).toEqual(['offers.pull', 'price.push'])
  })
})
