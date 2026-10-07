import {
  AuthExpiredError,
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

/** What the fake Channel remembers; owned by `createFakeChannel`. */
export interface FakeState {
  offers: Offer[]
  orders: Map<string, Order>
  journal: Array<{ seq: number; orderExternalId: string }>
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
      async 'orders.pull'(ctx, cursor): Promise<PullResult<Order>> {
        await request(ctx, 'orders.pull')
        const after = parseCursor(cursor)
        const pending = state.journal.filter((entry) => entry.seq > after)
        const page = pending.slice(0, PAGE_SIZE)
        const items = page.map((entry) => structuredClone(state.orders.get(entry.orderExternalId)!))
        return {
          items,
          nextCursor: page.length > 0 ? String(page[page.length - 1]!.seq) : cursor,
          hasMore: pending.length > page.length,
        }
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
