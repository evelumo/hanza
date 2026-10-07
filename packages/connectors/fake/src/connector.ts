import {
  AuthExpiredError,
  PermanentError,
  RateLimitedError,
  TransientError,
  defineConnector,
  type CapabilityContext,
  type ConnectorDefinition,
  type Offer,
  type OfferPrice,
  type Order,
  type OrderStatus,
  type PricePushResult,
  type PullResult,
  type StockLevel,
  type StockPushResult,
} from '@hanza/connector-sdk'
import { z } from 'zod'

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

export function createFakeConnector(state: FakeState, id = 'fake'): FakeConnector {
  return defineConnector({
    id,
    name: 'Test channel',
    kind: 'marketplace',
    auth: { type: 'apiKey' },
    reopensSoldOutOffers: true,
    configSchema: fakeConfigSchema,
    credentialsSchema: fakeCredentialsSchema,
    capabilities: {
      async 'offers.pull'(ctx, cursor): Promise<PullResult<Offer>> {
        failIfRequested(ctx)
        const start = parseCursor(cursor)
        const items = state.offers.slice(start, start + PAGE_SIZE)
        const end = start + items.length
        return { items: structuredClone(items), nextCursor: String(end), hasMore: end < state.offers.length }
      },
      async 'orders.pull'(ctx, cursor): Promise<PullResult<Order>> {
        failIfRequested(ctx)
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
      // for another reason refuses a number above 0. offers.pull then reports what the push did.
      async 'stock.push'(ctx, levels) {
        failIfRequested(ctx)
        state.stockPushes.push(structuredClone(levels))
        const results: StockPushResult[] = []
        for (const { offerExternalId, available } of levels) {
          const code = rejectedBy(ctx, state, offerExternalId)
          if (code !== undefined) {
            results.push({ offerExternalId, outcome: 'rejected', code })
            continue
          }
          const offer = state.offers.find((candidate) => candidate.externalId === offerExternalId)
          if (!offer || offer.status === 'inactive') continue
          if (available === 0) {
            if (offer.status === 'active') {
              offer.status = 'ended'
              offer.endedReason = 'sold_out'
              results.push({ offerExternalId, outcome: 'ended' })
            }
          } else if (offer.status === 'ended') {
            if (offer.endedReason === 'sold_out') {
              offer.status = 'active'
              delete offer.endedReason
            } else {
              results.push({ offerExternalId, outcome: 'rejected', code: FAKE_OFFER_ENDED_CODE })
            }
          }
        }
        return results
      },
      async 'price.push'(ctx, prices) {
        failIfRequested(ctx)
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
        failIfRequested(ctx)
        state.statusUpdates.push({ ...input })
      },
    },
  })
}
