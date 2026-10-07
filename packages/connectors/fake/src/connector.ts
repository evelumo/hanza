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
