import {
  defineConnector,
  errorFromResponse,
  orderSchema,
  PermanentError,
  TransientError,
  type CapabilityContext,
  type ConnectorDefinition,
  type Offer,
  type Order,
  type OrderPhase,
} from '@hanza/connector-sdk'
import { z } from 'zod'
import {
  API_STATUSES,
  offersPageSchema,
  ordersPageSchema,
  tokenResponseSchema,
  type ApiOrder,
} from './api'

export const FAKE_HTTP_BASE_URL = 'https://fake-channel.example.test'

export const fakeHttpConfigSchema = z.object({
  baseUrl: z.url().default(FAKE_HTTP_BASE_URL).describe('API base URL'),
})

export const fakeHttpCredentialsSchema = z.object({
  clientId: z.string().min(1).describe('Client ID'),
  clientSecret: z.string().min(1).describe('Client secret'),
})

type Ctx = CapabilityContext<z.output<typeof fakeHttpConfigSchema>, z.output<typeof fakeHttpCredentialsSchema>>

export type FakeHttpConnector = ConnectorDefinition<typeof fakeHttpConfigSchema, typeof fakeHttpCredentialsSchema>

/** What the HTTP helpers need from a capability's or a sign-in hook's context. */
export type HttpContext = { fetch: typeof fetch; config: { baseUrl: string } }

export async function send(ctx: HttpContext, path: string, init: RequestInit = {}): Promise<Response> {
  let response: Response
  try {
    response = await ctx.fetch(new URL(path, ctx.config.baseUrl), {
      ...init,
      headers: { accept: 'application/json', ...init.headers },
    })
  } catch (error) {
    throw new TransientError('The fake Channel could not be reached', { cause: error })
  }
  if (!response.ok) throw await errorFromResponse(response)
  return response
}

export async function parse<T extends z.ZodType>(response: Response, schema: T, what: string): Promise<z.output<T>> {
  const parsed = schema.safeParse(await response.json().catch(() => undefined))
  // Paths only: a message could echo Buyer data back.
  if (!parsed.success) throw new PermanentError(`Unexpected ${what} response: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`)
  return parsed.data
}

/** Client credentials for a short-lived token on every call: a connector keeps no state between calls. */
async function authorized(ctx: Ctx, path: string, init: RequestInit = {}): Promise<Response> {
  const tokenResponse = await send(ctx, '/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: ctx.credentials.clientId, client_secret: ctx.credentials.clientSecret }),
  })
  const { access_token: token } = await parse(tokenResponse, tokenResponseSchema, 'token')
  return send(ctx, path, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } })
}

const name = (person: { firstName: string; lastName: string }) => `${person.firstName} ${person.lastName}`.trim()

export function mapOrder(order: ApiOrder): Order {
  const mapped = orderSchema.safeParse({
    externalId: order.id,
    placedAt: order.createdAt,
    payment: order.paymentType === 'ONLINE' ? 'prepaid' : 'cash_on_delivery',
    ...(order.awaitingPayment ? { awaitingPayment: true } : {}),
    total: order.total,
    buyer: { name: name(order.buyer), email: order.buyer.email, phone: order.buyer.phone, login: order.buyer.login },
    shippingAddress: {
      name: name(order.delivery),
      company: order.delivery.company,
      street: order.delivery.street,
      postalCode: order.delivery.zipCode,
      city: order.delivery.city,
      countryCode: order.delivery.countryCode,
      phone: order.delivery.phone,
      taxId: null,
    },
    billingAddress: null,
    lines: order.lines.map((line) => ({
      externalId: line.id,
      offerExternalId: line.offerId,
      sku: line.sku,
      name: line.name,
      quantity: line.quantity,
      unitPrice: line.price,
    })),
    facts: order.events.map((event) => ({
      id: event.id,
      type: event.type === 'SENT' ? 'shipped' : event.type === 'PAID' ? 'paid' : 'cancelled',
      occurredAt: event.at,
      note: event.note,
    })),
  })
  if (!mapped.success) throw new PermanentError(`Order ${order.id} does not fit the canonical model: ${mapped.error.issues.map((issue) => issue.path.join('.')).join(', ')}`)
  return mapped.data
}

/**
 * The fake Channel over HTTP: the same Offers and Orders as the in-memory `fake`, behind a small JSON API
 * with client-credentials tokens (`./server.ts`). Exists to show a connector tested with recorded fixtures.
 */
export function createFakeHttpConnector(id = 'fake-http'): FakeHttpConnector {
  return defineConnector({
    id,
    name: 'Test channel (HTTP)',
    kind: 'marketplace',
    auth: { type: 'oauth2' },
    configSchema: fakeHttpConfigSchema,
    credentialsSchema: fakeHttpCredentialsSchema,
    capabilities: {
      async 'offers.pull'(ctx, cursor) {
        const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`
        const page = await parse(await authorized(ctx, `/offers${query}`), offersPageSchema, 'offers')
        const items: Offer[] = page.offers.map((offer) => ({ externalId: offer.id, sku: offer.sku, name: offer.title, url: null, price: offer.price }))
        return { items, nextCursor: page.cursor, hasMore: page.more }
      },
      async 'orders.pull'(ctx, cursor) {
        const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`
        const page = await parse(await authorized(ctx, `/orders${query}`), ordersPageSchema, 'orders')
        return { items: page.orders.map(mapOrder), nextCursor: page.cursor, hasMore: page.more }
      },
      async 'stock.push'(ctx, levels) {
        if (levels.length === 0) return
        const items = levels.map((level) => ({ offerId: level.offerExternalId, sku: level.sku, quantity: level.available }))
        await authorized(ctx, '/stock', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items }) })
      },
      async 'orders.updateStatus'(ctx, input: { orderExternalId: string; phase: OrderPhase }) {
        await authorized(ctx, `/orders/${encodeURIComponent(input.orderExternalId)}/status`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: API_STATUSES[input.phase] }),
        })
      },
    },
  })
}
