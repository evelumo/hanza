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
  type PullResult,
  type StockLevel,
} from '@hanza/connector-sdk'
import { z } from 'zod'

export const fakeConfigSchema = z.object({
  failMode: z.enum(['none', 'rate_limited', 'transient', 'permanent']).default('none').describe('Failure simulation'),
})

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

export function createFakeConnector(state: FakeState): FakeConnector {
  return defineConnector({
    id: 'fake',
    name: 'Test channel',
    kind: 'marketplace',
    auth: { type: 'apiKey' },
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
      async 'stock.push'(ctx, levels) {
        failIfRequested(ctx)
        state.stockPushes.push(structuredClone(levels))
      },
      async 'price.push'(ctx, prices) {
        failIfRequested(ctx)
        state.pricePushes.push(structuredClone(prices))
        // Like a real Channel, the next offers.pull reports the price that was set.
        for (const { offerExternalId, price } of prices) {
          const offer = state.offers.find((candidate) => candidate.externalId === offerExternalId)
          if (offer) offer.price = { ...price }
        }
      },
      async 'orders.updateStatus'(ctx, input) {
        failIfRequested(ctx)
        state.statusUpdates.push({ ...input })
      },
    },
  })
}
