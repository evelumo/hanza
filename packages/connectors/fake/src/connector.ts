import {
  AuthExpiredError,
  CursorExpiredError,
  PermanentError,
  RateLimitedError,
  TransientError,
  defineConnector,
  errorFromResponse,
  isConnectorError,
  type CapabilityContext,
  type ConnectorDefinition,
  type Offer,
  type OfferPrice,
  type Order,
  type OrderStatus,
  type OrderUpdate,
  type PullResult,
  type RateLimits,
  type StockLevel,
} from '@hanza/connector-sdk'
import { z } from 'zod'
import { FAKE_API_URL } from './api'

export const fakeConfigSchema = z.object({
  failMode: z.enum(['none', 'rate_limited', 'transient', 'permanent']).default('none').describe('Failure simulation'),
})

export const fakeCredentialsSchema = z.object({ apiKey: z.string().min(1).describe('API key') })

export type FakeContext = CapabilityContext<z.output<typeof fakeConfigSchema>, z.output<typeof fakeCredentialsSchema>>

/** One journal entry: the Order as it is when pulled, or exactly this Order update. */
export interface FakeJournalEntry {
  seq: number
  orderExternalId: string
  update?: OrderUpdate
}

/** What the fake Channel remembers; owned by `createFakeChannel`. */
export interface FakeState {
  offers: Offer[]
  orders: Map<string, Order>
  /** Orders removed on the Channel (merged into another): what any entry of theirs is pulled as from then on. */
  removed: Map<string, OrderUpdate>
  /** Journal seq of each Order's first entry: the listing of open Orders shows only Orders the journal had by then. */
  firstSeq: Map<string, number>
  journal: FakeJournalEntry[]
  /** Seq of the newest entry ever appended (forgotten ones included). */
  lastSeq: number
  /** Entries up to this seq were forgotten: an older cursor has expired. */
  forgottenThrough: number
  /** Cursor null lists the open Orders first, then follows the journal (the SDK's starting rule); else replays the whole journal. */
  startWithOpenOrders: boolean
  stockPushes: StockLevel[][]
  pricePushes: OfferPrice[][]
  statusUpdates: Array<{ orderExternalId: string; status: OrderStatus }>
}

const PAGE_SIZE = 2

function parseCursor(cursor: string | null): number {
  if (cursor === null) return 0
  if (!/^\d+$/.test(cursor)) throw new PermanentError(`Invalid cursor "${cursor}"`)
  return Number(cursor)
}

const LISTING_CURSOR = /^l:(\d+):(\d+)$/
const JOURNAL_CURSOR = /^e:(\d+)$/

function isOpen(order: Order): boolean {
  return !order.facts.some((fact) => fact.type === 'cancelled' || fact.type === 'shipped')
}

function entryItem(state: FakeState, entry: FakeJournalEntry): Order | OrderUpdate {
  if (entry.update) return structuredClone(entry.update)
  const order = state.orders.get(entry.orderExternalId)
  // Like a real Channel answering 404 for a merged purchase: the connector reports it as removed.
  return structuredClone(order ?? state.removed.get(entry.orderExternalId)!)
}

function expireIfForgotten(state: FakeState, position: number): void {
  if (position < state.forgottenThrough) {
    throw new CursorExpiredError(`The journal no longer has position ${position}`)
  }
}

/** Journal entries after `after`, one page; the cursor format is the caller's. */
function journalPage(state: FakeState, after: number, cursorOf: (seq: number) => string, cursor: string | null) {
  const pending = state.journal.filter((entry) => entry.seq > after)
  const page = pending.slice(0, PAGE_SIZE)
  return {
    items: page.map((entry) => entryItem(state, entry)),
    nextCursor: page.length > 0 ? cursorOf(page[page.length - 1]!.seq) : cursor,
    hasMore: pending.length > page.length,
  }
}

/**
 * The SDK's starting rule: cursor null takes the journal position first, lists the Orders open now that the journal
 * had by then (`l:<position>:<offset>`), then follows the journal from that position (`e:<seq>`).
 */
function pullOpenThenJournal(state: FakeState, cursor: string | null): PullResult<Order | OrderUpdate> {
  const journal = cursor === null ? null : JOURNAL_CURSOR.exec(cursor)
  if (journal) {
    const after = Number(journal[1])
    expireIfForgotten(state, after)
    return journalPage(state, after, (seq) => `e:${seq}`, cursor)
  }
  const listing = cursor === null ? null : LISTING_CURSOR.exec(cursor)
  if (cursor !== null && !listing) throw new PermanentError(`Invalid cursor "${cursor}"`)
  const position = listing ? Number(listing[1]) : state.lastSeq
  const offset = listing ? Number(listing[2]) : 0
  expireIfForgotten(state, position)
  const open = [...state.orders.values()].filter((order) => isOpen(order) && (state.firstSeq.get(order.externalId) ?? Infinity) <= position)
  const page = open.slice(offset, offset + PAGE_SIZE)
  const end = offset + page.length
  if (end < open.length) return { items: structuredClone(page), nextCursor: `l:${position}:${end}`, hasMore: true }
  return {
    items: structuredClone(page),
    nextCursor: `e:${position}`,
    hasMore: state.journal.some((entry) => entry.seq > position),
  }
}

function failIfRequested(ctx: FakeContext): void {
  if (ctx.credentials.apiKey === 'expired') throw new AuthExpiredError('The API key has expired')
  switch (ctx.config.failMode) {
    case 'rate_limited':
      throw new RateLimitedError('Too many requests', { retryAfterMs: 1000 })
    case 'transient':
      throw new TransientError('The Channel is temporarily unavailable')
    case 'permanent':
      throw new PermanentError('The Channel rejected the request')
    case 'none':
      return
  }
}

export type FakeConnector = ConnectorDefinition<typeof fakeConfigSchema, typeof fakeCredentialsSchema>

export interface FakeConnectorOptions {
  id?: string
  /** Send one request per call through `ctx.fetch` to `FAKE_API_URL`, the way a real connector talks to its Channel. */
  http?: boolean
  rateLimits?: RateLimits
}

export function createFakeConnector(state: FakeState, options: FakeConnectorOptions = {}): FakeConnector {
  // What a real connector's client does: authenticate, map a failed response, and let the core's errors through.
  const request = async (ctx: FakeContext, operation: string) => {
    failIfRequested(ctx)
    if (!options.http) return
    let response: Response
    try {
      response = await ctx.fetch(`${FAKE_API_URL}/${operation}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ctx.credentials.apiKey}` },
      })
    } catch (error) {
      // E.g. the RateLimitedError of the core's limiter: wrapping it would turn a wait into a failure.
      if (isConnectorError(error)) throw error
      throw new TransientError('The Channel could not be reached', { cause: error })
    }
    if (!response.ok) throw await errorFromResponse(response)
    await response.body?.cancel()
  }

  return defineConnector({
    id: options.id ?? 'fake',
    name: 'Test channel',
    kind: 'marketplace',
    auth: { type: 'apiKey' },
    configSchema: fakeConfigSchema,
    credentialsSchema: fakeCredentialsSchema,
    ...(options.rateLimits ? { rateLimits: options.rateLimits } : {}),
    capabilities: {
      async 'offers.pull'(ctx, cursor): Promise<PullResult<Offer>> {
        await request(ctx, 'offers.pull')
        const start = parseCursor(cursor)
        const items = state.offers.slice(start, start + PAGE_SIZE)
        const end = start + items.length
        return { items: structuredClone(items), nextCursor: String(end), hasMore: end < state.offers.length }
      },
      async 'orders.pull'(ctx, cursor): Promise<PullResult<Order | OrderUpdate>> {
        await request(ctx, 'orders.pull')
        if (state.startWithOpenOrders) return pullOpenThenJournal(state, cursor)
        const after = parseCursor(cursor)
        // Null replays whatever the journal still has; a cursor into the forgotten part has expired.
        if (cursor !== null) expireIfForgotten(state, after)
        return journalPage(state, after, String, cursor)
      },
      async 'stock.push'(ctx, levels) {
        await request(ctx, 'stock.push')
        state.stockPushes.push(structuredClone(levels))
      },
      async 'price.push'(ctx, prices) {
        await request(ctx, 'price.push')
        state.pricePushes.push(structuredClone(prices))
        // Like a real Channel, the next offers.pull reports the price that was set.
        for (const { offerExternalId, price } of prices) {
          const offer = state.offers.find((candidate) => candidate.externalId === offerExternalId)
          if (offer) offer.price = { ...price }
        }
      },
      async 'orders.updateStatus'(ctx, input) {
        await request(ctx, 'orders.updateStatus')
        state.statusUpdates.push({ ...input })
      },
    },
  })
}
