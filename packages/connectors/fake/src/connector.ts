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
  type PricePushResult,
  type PullResult,
  type RateLimits,
  type StockLevel,
  type StockPushResult,
} from '@hanza/connector-sdk'
import { z } from 'zod'
import { FAKE_API_URL } from './api'

export const fakeConfigSchema = z.object({
  failMode: z.enum(['none', 'rate_limited', 'transient', 'permanent']).default('none').describe('Failure simulation'),
  rejectOffers: z.string().max(1000).default('').describe('Offers that refuse stock and prices (comma-separated ids)'),
})

/** The code the fake Channel refuses an Offer's stock or price with. */
export const FAKE_REJECTED_CODE = 'FAKE_REJECTED'
/** The code it refuses a number above 0 for an Offer that ended for another reason than selling out with. */
export const FAKE_OFFER_ENDED_CODE = 'OFFER_ENDED'

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
  /** Offers whose stock and price this Channel refuses, with the code it answers. */
  rejections: Map<string, string>
  /**
   * What stock pushes did to each Offer's publication, per seller account (the API key): on a real marketplace every
   * Connection is its own account with its own Offers, so one Connection ending an Offer must not end another's.
   */
  publications: Map<string, Map<string, Publication>>
}

type Publication = Pick<Offer, 'status' | 'endedReason'>

/** The Offer as this account sees it: its own publication if a push changed it, else the catalogue's. */
export function withPublication(state: FakeState, account: string, offer: Offer): Offer {
  const own = state.publications.get(account)?.get(offer.externalId)
  if (!own) return offer
  const { endedReason: _dropped, ...rest } = offer
  return { ...rest, status: own.status, ...(own.endedReason ? { endedReason: own.endedReason } : {}) }
}

function rejectedBy(ctx: FakeContext, state: FakeState, offerExternalId: string): string | undefined {
  const configured = ctx.config.rejectOffers.split(',').map((id) => id.trim())
  return configured.includes(offerExternalId) ? FAKE_REJECTED_CODE : state.rejections.get(offerExternalId)
}

const PAGE_SIZE = 2

function parseCursor(cursor: string | null): number {
  if (cursor === null) return 0
  if (!/^\d+$/.test(cursor)) throw new PermanentError(`Invalid cursor "${cursor}"`)
  return Number(cursor)
}

// The feed's start (the journal position taken before the listing) stays in every cursor of the feed, for ever.
const LISTING_CURSOR = /^l:(\d+):(\d+)$/
const JOURNAL_CURSOR = /^e:(\d+):(\d+)$/

function isOpen(order: Order): boolean {
  return !order.facts.some((fact) => fact.type === 'cancelled' || fact.type === 'shipped')
}

/** What a journal entry is pulled as; `fullFor` decides which Orders may still be sent whole. */
function entryItem(state: FakeState, entry: FakeJournalEntry, fullFor: (orderExternalId: string) => boolean = () => true): Order | OrderUpdate {
  if (entry.update) return structuredClone(entry.update)
  const order = state.orders.get(entry.orderExternalId)
  // Like a real Channel answering 404 for a merged purchase: the connector reports it as removed.
  if (!order) return structuredClone(state.removed.get(entry.orderExternalId)!)
  if (fullFor(order.externalId)) return structuredClone(order)
  // An Order the Channel had before the feed started goes as an update: if Hanza never imported it (closed before
  // the Connection), it is ignored instead of consuming Stock the seller already counted (ADR 0021).
  return { kind: 'update', externalId: order.externalId, facts: structuredClone(order.facts) }
}

function expireIfForgotten(state: FakeState, position: number): void {
  if (position < state.forgottenThrough) {
    throw new CursorExpiredError(`The journal no longer has position ${position}`)
  }
}

/** Journal entries after `after`, one page; the cursor format is the caller's. */
function journalPage(
  state: FakeState,
  after: number,
  cursorOf: (seq: number) => string,
  cursor: string | null,
  fullFor?: (orderExternalId: string) => boolean,
) {
  const pending = state.journal.filter((entry) => entry.seq > after)
  const page = pending.slice(0, PAGE_SIZE)
  return {
    items: page.map((entry) => entryItem(state, entry, fullFor)),
    nextCursor: page.length > 0 ? cursorOf(page[page.length - 1]!.seq) : cursor,
    hasMore: pending.length > page.length,
  }
}

/**
 * The SDK's starting rule (ADR 0021). Cursor null takes the journal position first (the feed's start), lists the Orders
 * open now that the journal had by then, then follows the journal from that position. The listing pages by keyset
 * (`l:<start>:<first seq of the last Order listed>`): the order (first seq) and the upper bound (the start) never change,
 * so an Order closing between two pages cannot make another one skipped. In the journal (`e:<start>:<seq>`) a full
 * Order is sent only for an Order placed after the start; any other Order goes as an Order update.
 */
function pullOpenThenJournal(state: FakeState, cursor: string | null): PullResult<Order | OrderUpdate> {
  const firstSeq = (orderExternalId: string) => state.firstSeq.get(orderExternalId) ?? Infinity
  const journal = cursor === null ? null : JOURNAL_CURSOR.exec(cursor)
  if (journal) {
    const start = Number(journal[1])
    const after = Number(journal[2])
    if (after < start) throw new PermanentError(`Invalid cursor "${cursor}"`)
    expireIfForgotten(state, after)
    return journalPage(state, after, (seq) => `e:${start}:${seq}`, cursor, (id) => firstSeq(id) > start)
  }
  const listing = cursor === null ? null : LISTING_CURSOR.exec(cursor)
  if (cursor !== null && !listing) throw new PermanentError(`Invalid cursor "${cursor}"`)
  const start = listing ? Number(listing[1]) : state.lastSeq
  const afterKey = listing ? Number(listing[2]) : 0
  expireIfForgotten(state, start)
  const open = [...state.orders.values()]
    .filter((order) => isOpen(order) && firstSeq(order.externalId) > afterKey && firstSeq(order.externalId) <= start)
    .sort((a, b) => firstSeq(a.externalId) - firstSeq(b.externalId))
  const page = open.slice(0, PAGE_SIZE)
  if (open.length > page.length) {
    return { items: structuredClone(page), nextCursor: `l:${start}:${firstSeq(page.at(-1)!.externalId)}`, hasMore: true }
  }
  return {
    items: structuredClone(page),
    nextCursor: `e:${start}:${start}`,
    hasMore: state.journal.some((entry) => entry.seq > start),
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
    reopensSoldOutOffers: true,
    configSchema: fakeConfigSchema,
    credentialsSchema: fakeCredentialsSchema,
    ...(options.rateLimits ? { rateLimits: options.rateLimits } : {}),
    capabilities: {
      async 'offers.pull'(ctx, cursor): Promise<PullResult<Offer>> {
        await request(ctx, 'offers.pull')
        const start = parseCursor(cursor)
        const items = state.offers.slice(start, start + PAGE_SIZE).map((offer) => withPublication(state, ctx.credentials.apiKey, offer))
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
      // Like Allegro: 0 ends an active Offer (sold out), a number above 0 reopens a sold-out one, and an Offer ended
      // for another reason refuses a number above 0; checked here, at push time, whatever Hanza last pulled. A 0 that
      // leaves the Offer sold out is reported `ended` every time, so a retried push after a lost answer still says so.
      // offers.pull then reports what the pushes of this account did.
      async 'stock.push'(ctx, levels) {
        await request(ctx, 'stock.push')
        state.stockPushes.push(structuredClone(levels))
        const account = ctx.credentials.apiKey
        const own = state.publications.get(account) ?? new Map<string, Publication>()
        state.publications.set(account, own)
        const results: StockPushResult[] = []
        for (const { offerExternalId, available } of levels) {
          const code = rejectedBy(ctx, state, offerExternalId)
          if (code !== undefined) {
            results.push({ offerExternalId, outcome: 'rejected', code })
            continue
          }
          const known = state.offers.find((candidate) => candidate.externalId === offerExternalId)
          if (!known) continue
          const { status, endedReason } = withPublication(state, account, known)
          if (status === 'inactive') continue
          const soldOut = status === 'ended' && endedReason === 'sold_out'
          if (available === 0) {
            if (status === 'ended' && !soldOut) continue
            if (!soldOut) own.set(offerExternalId, { status: 'ended', endedReason: 'sold_out' })
            results.push({ offerExternalId, outcome: 'ended' })
          } else if (status === 'ended') {
            if (soldOut) own.set(offerExternalId, { status: 'active' })
            else results.push({ offerExternalId, outcome: 'rejected', code: FAKE_OFFER_ENDED_CODE })
          }
        }
        return results
      },
      async 'price.push'(ctx, prices) {
        await request(ctx, 'price.push')
        state.pricePushes.push(structuredClone(prices))
        const results: PricePushResult[] = []
        for (const { offerExternalId, price } of prices) {
          const code = rejectedBy(ctx, state, offerExternalId)
          if (code !== undefined) {
            results.push({ offerExternalId, outcome: 'rejected', code })
            continue
          }
          // Like a real Channel, the next offers.pull reports the price that was set.
          const offer = state.offers.find((candidate) => candidate.externalId === offerExternalId)
          if (offer) offer.price = { ...price }
        }
        return results
      },
      async 'orders.updateStatus'(ctx, input) {
        await request(ctx, 'orders.updateStatus')
        state.statusUpdates.push({ ...input })
      },
    },
  })
}
