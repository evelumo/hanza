import {
  CursorExpiredError,
  defineConnector,
  PermanentError,
  type AnyConnectorDefinition,
  type Offer,
  type Order,
  type PullResult,
  type StockLevel,
} from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { retryOfferPush } from '../catalog/offer-push'
import { getOffer, linkOffer, upsertOffers } from '../catalog/offers'
import { createProduct } from '../catalog/products'
import { createConnection } from '../connections/connections'
import { failSyncRun, mayPushStock } from '../connections/sync-state'
import { PermanentJobError } from '../jobs'
import { setStock } from '../stock/set-stock'
import { requestSync } from '../sync/requests'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, orderLine, uniqueSku, user } from '../testing/fixtures'
import { offersPullJob } from './offers-pull'
import { ordersPullJob } from './orders-pull'
import { pricePushJob } from './price-push'
import { stockPushJob } from './stock-push'

// A Channel is told no Stock before its Order feed has been read to its end (ADR 0023).

const pushes: StockLevel[][] = []
/** The capabilities called, in order. */
const called: string[] = []
const nothing = async () => ({ items: [], nextCursor: null, hasMore: false })
let offersFeed: () => Promise<PullResult<Offer>> = nothing
let ordersFeed: (cursor: string | null) => Promise<PullResult<Order>> = nothing

const channel = defineConnector({
  id: 'first-pull-channel',
  name: 'First pull channel',
  kind: 'shop',
  auth: { type: 'none' },
  configSchema: z.object({}),
  credentialsSchema: z.object({}),
  capabilities: {
    async 'offers.pull'() {
      called.push('offers.pull')
      return offersFeed()
    },
    async 'orders.pull'(_ctx, cursor) {
      called.push('orders.pull')
      return ordersFeed(cursor)
    },
    async 'stock.push'(_ctx, levels) {
      called.push('stock.push')
      pushes.push(levels)
    },
  },
})

// `defineConnector` refuses a Channel without an Order feed, so this one is written out.
const pushOnly = { ...channel, id: 'push-only', capabilities: { 'stock.push': channel.capabilities['stock.push'] } } as AnyConnectorDefinition

const run = { attempt: 1, maxAttempts: 5, retriedLater: 0 }

/** A feed with a backlog longer than one run: every page says there is more. */
const backlog = async (cursor: string | null): Promise<PullResult<Order>> => ({ items: [], nextCursor: String(Number(cursor ?? 0) + 1), hasMore: true })

describe.skipIf(!databaseUrl)('stock.push waits for the first Orders pull', () => {
  const context = useTestContext({ connectors: [channel, pushOnly] })

  /** A Connection nothing has synced yet, with a Product in stock. */
  async function setup(connectorId = 'first-pull-channel') {
    const ctx = context()
    const organizationId = await createTestOrganization(ctx.db)
    const { connectionId } = await createConnection(ctx, organizationId, { connectorId, name: 'Shop', config: {}, credentials: {} }, user)
    const sku = uniqueSku()
    const { productId } = await createProduct(ctx, organizationId, { sku, name: 'A', stock: 20 }, user)
    offersFeed = nothing
    ordersFeed = nothing
    ctx.queue.waiting.splice(0)

    const linkOfferA = () => upsertOffers(ctx, organizationId, connectionId, [{ externalId: 'offer-a', sku, name: 'A', url: null }], new Date())
    const offer = () => ctx.db.offer.findFirstOrThrow({ where: { organizationId, connectionId, externalId: 'offer-a' } })
    const offerView = async () => getOffer(ctx, organizationId, (await offer()).id)
    /** Runs the stock push; returns the numbers each call sent. */
    const push = async () => {
      pushes.length = 0
      await stockPushJob.handler(ctx, { organizationId, connectionId }, run)
      return pushes.map((levels) => levels.map((level) => level.available))
    }
    const pullOrders = () => ordersPullJob.handler(ctx, { organizationId, connectionId, trigger: 'schedule' }, run)
    const waiting = () =>
      ctx.queue.waiting.filter((job) => (job.payload as { connectionId?: string }).connectionId === connectionId).map((job) => job.name)
    const state = (stream: 'orders_pull' | 'stock_push') => ctx.db.syncState.findFirstOrThrow({ where: { organizationId, connectionId, stream } })
    const openOrder = (quantity: number) => buildOrder({ lines: [orderLine('l1', { sku, quantity })] })
    return { ctx, organizationId, connectionId, sku, productId, linkOfferA, offer, offerView, push, pullOrders, waiting, state, openOrder }
  }

  it('tells a new Channel nothing until its Order feed is read to the end, then Stock less the Orders open there', async () => {
    const t = await setup()
    await t.linkOfferA()
    expect(await t.push()).toEqual([])
    // Still waiting to be sent, and a run that sent nothing is no success of the stream.
    expect(await t.offer()).toMatchObject({ stockPushSeq: 1, stockPushedSeq: 0, lastPushedAt: null, lastPushedAvailable: null })
    expect(await t.state('stock_push')).toMatchObject({ lastSucceededAt: null, lastResult: null })
    expect(t.waiting()).toEqual([])

    // The shop's own open Orders: nine of the twenty are sold already.
    ordersFeed = async () => ({ items: [t.openOrder(9)], nextCursor: 'c1', hasMore: false })
    await t.pullOrders()
    // Importing the Order asked for the push and so did the run that reached the end; the two coalesce.
    expect(t.waiting()).toEqual(['stock.push'])
    expect(await t.push()).toEqual([[11]])
    expect(await t.offer()).toMatchObject({ lastPushedAvailable: 11 })
  })

  it('a first sync of the whole Connection reads the Orders before it pushes anything', async () => {
    const { ctx, organizationId, connectionId, sku, openOrder } = await setup()
    offersFeed = async () => ({ items: [{ externalId: 'offer-a', sku, name: 'A', url: null }], nextCursor: null, hasMore: false })
    ordersFeed = async () => ({ items: [openOrder(9)], nextCursor: 'c1', hasMore: false })
    called.length = 0
    pushes.length = 0

    await requestSync(ctx, organizationId, connectionId)
    expect(await ctx.queue.drain(ctx, [offersPullJob, ordersPullJob, stockPushJob, pricePushJob])).toMatchObject({ failed: [] })

    // The stock push requested with the sync ran before the Orders pull, and sent nothing.
    expect(called).toEqual(['offers.pull', 'orders.pull', 'stock.push'])
    expect(pushes).toEqual([[{ offerExternalId: 'offer-a', sku, available: 11 }]])
  })

  it('keeps waiting while the first read of the feed takes several runs', async () => {
    const t = await setup()
    await t.linkOfferA()
    ordersFeed = backlog
    await t.pullOrders()
    // A successful run with more to read: it continues, and the Channel is still told nothing.
    expect(await t.state('orders_pull')).toMatchObject({ lastErrorKind: null, lastResult: { pulled: 0, imported: 0, factsApplied: 0, pages: 20, more: 1 } })
    expect((await t.state('orders_pull')).lastSucceededAt).not.toBeNull()
    expect(t.waiting()).toEqual(['orders.pull'])
    expect(await t.push()).toEqual([])

    t.ctx.queue.waiting.splice(0)
    ordersFeed = async (cursor) => ({ items: [t.openOrder(4)], nextCursor: cursor, hasMore: false })
    await t.pullOrders()
    expect((await t.state('orders_pull')).lastResult).toEqual({ pulled: 1, imported: 1, factsApplied: 0, pages: 1 })
    expect(t.waiting()).toEqual(['stock.push'])
    expect(await t.push()).toEqual([[16]])
  })

  it('a push asked for by a Stock edit, a link or a Retry waits too, and nothing of it is lost', async () => {
    const t = await setup()
    const { ctx, organizationId, connectionId } = t
    await t.linkOfferA()
    const other = await createProduct(ctx, organizationId, { sku: uniqueSku(), name: 'B', stock: 7 }, user)
    await upsertOffers(ctx, organizationId, connectionId, [{ externalId: 'offer-b', sku: null, name: 'B', url: null }], new Date())
    const second = await ctx.db.offer.findFirstOrThrow({ where: { organizationId, connectionId, externalId: 'offer-b' } })

    await setStock(ctx, organizationId, t.productId, 15, user)
    await linkOffer(ctx, organizationId, second.id, other.productId, user)
    await retryOfferPush(ctx, organizationId, (await t.offer()).id, 'stock', user)
    expect(t.waiting()).toContain('stock.push')
    expect(await t.push()).toEqual([])
    // What a person sees on the Offer meanwhile.
    expect(await t.offerView()).toMatchObject({ stockStatus: 'pending', lastPushedAvailable: null })

    await t.pullOrders()
    expect((await t.push()).map((levels) => [...levels].sort((a, b) => a - b))).toEqual([[7, 15]])
    expect(await t.offerView()).toMatchObject({ stockStatus: 'pushed', lastPushedAvailable: 15 })
  })

  it('while the Orders pull keeps failing nothing is pushed: the Connection is failing and the Offer waits', async () => {
    const t = await setup()
    await t.linkOfferA()
    ordersFeed = async () => {
      throw new PermanentError('The shop refuses to list orders')
    }
    await expect(t.pullOrders()).rejects.toBeInstanceOf(PermanentJobError)
    expect(t.waiting()).toEqual([])
    expect(await t.push()).toEqual([])
    expect(await t.ctx.db.connection.findFirstOrThrow({ where: { id: t.connectionId, organizationId: t.organizationId } })).toMatchObject({ health: 'failing' })
    expect(await t.state('orders_pull')).toMatchObject({ lastSucceededAt: null, lastErrorKind: 'permanent', lastError: 'The shop refuses to list orders' })
    expect(await t.offerView()).toMatchObject({ stockStatus: 'pending' })

    // Once the feed can be read, the number goes out.
    ordersFeed = nothing
    await t.pullOrders()
    expect(await t.push()).toEqual([[20]])
  })

  it('a Connection from before this rule keeps pushing: its Orders pull succeeded, or it was told Stock already', async () => {
    // As the older Orders pull left it: a result without the marker, also when the run stopped at the page limit.
    const pulled = await setup()
    await pulled.linkOfferA()
    await pulled.ctx.db.syncState.create({
      data: {
        organizationId: pulled.organizationId,
        connectionId: pulled.connectionId,
        stream: 'orders_pull',
        cursor: 'c9',
        lastSucceededAt: new Date('2026-10-01T00:00:00Z'),
        lastResult: { pulled: 0, imported: 0, factsApplied: 0, pages: 1 },
      },
    })
    expect(await pulled.push()).toEqual([[20]])

    // Its Orders pull never worked, but the Channel has been getting numbers.
    const told = await setup()
    await told.linkOfferA()
    await failSyncRun(told.ctx, told.organizationId, told.connectionId, 'orders_pull', { kind: 'permanent', message: '403', health: 'failing' })
    expect(await told.push()).toEqual([])
    await told.ctx.db.syncState.updateMany({
      where: { organizationId: told.organizationId, connectionId: told.connectionId, stream: 'stock_push' },
      data: { lastSucceededAt: new Date('2026-10-01T00:00:00Z'), lastResult: { pushed: 1, rejected: 0, skipped: 0 } },
    })
    expect(await told.push()).toEqual([[20]])
  })

  it('a Channel that was told Stock keeps getting it while its feed restarts and falls behind', async () => {
    const t = await setup()
    await t.linkOfferA()
    await t.pullOrders()
    expect(await t.push()).toEqual([[20]])

    // The Channel lost the position: the feed starts again and does not reach its end in this run.
    await t.ctx.db.syncState.updateMany({ where: { connectionId: t.connectionId, stream: 'orders_pull' }, data: { cursor: 'old' } })
    ordersFeed = async (cursor) => {
      if (cursor === 'old') throw new CursorExpiredError('older than the journal')
      return backlog(cursor)
    }
    await t.pullOrders()
    expect(await t.state('orders_pull')).toMatchObject({ lastResult: { feedRestarts: 1, more: 1 } })

    // Another Channel sold three: this one must hear of it now, not when its own feed is read again.
    await setStock(t.ctx, t.organizationId, t.productId, 17, user)
    expect(await t.push()).toEqual([[17]])
  })

  it('a Channel never told Stock waits again while its feed is known to have more, and is told once that is read', async () => {
    const t = await setup()
    // Read to the end before any Offer was linked, so nothing was ever pushed.
    await t.pullOrders()
    expect(await t.push()).toEqual([])
    ordersFeed = backlog
    await t.pullOrders()
    await t.linkOfferA()
    expect(await t.push()).toEqual([])

    t.ctx.queue.waiting.splice(0)
    ordersFeed = async (cursor) => ({ items: [t.openOrder(2)], nextCursor: cursor, hasMore: false })
    await t.pullOrders()
    expect(t.waiting()).toEqual(['stock.push'])
    expect(await t.push()).toEqual([[18]])
  })

  it('an Orders pull that finds the feed read already asks for no push', async () => {
    const t = await setup()
    await t.linkOfferA()
    await t.pullOrders()
    expect(t.waiting()).toEqual(['stock.push'])
    expect(await t.push()).toEqual([[20]])
    t.ctx.queue.waiting.splice(0)
    await t.pullOrders()
    expect(t.waiting()).toEqual([])
  })

  it('a connector without an Order feed has nothing to wait for', async () => {
    const t = await setup('push-only')
    await t.linkOfferA()
    expect(await t.push()).toEqual([[20]])
  })

  it("another organization's question about the Connection is answered from nothing of it", async () => {
    const t = await setup()
    await t.pullOrders()
    expect(await mayPushStock(t.ctx, t.organizationId, t.connectionId)).toBe(true)
    expect(await mayPushStock(t.ctx, await createTestOrganization(t.ctx.db), t.connectionId)).toBe(false)
  })
})
