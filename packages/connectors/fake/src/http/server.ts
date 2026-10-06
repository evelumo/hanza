// Test and recording tooling only (`@hanza/connector-fake/http-server`): never imported by the connector itself.
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ConnectorError, Order } from '@hanza/connector-sdk'
import type { ScrubConfig } from '@hanza/connector-sdk/testing'
import { createFakeChannel, type FakeChannel } from '../channel'
import type { FakeContext } from '../connector'
import { API_STATUSES, statusRequestSchema, stockRequestSchema, type ApiOrder } from './api'
import { FAKE_HTTP_BASE_URL } from './connector'

/** What the fake Channel's fixtures must lose: names, the address, contact data, the PESEL-like id, the login and free-text notes. */
export const fakeHttpScrub: ScrubConfig = {
  keys: {
    firstName: 'text',
    lastName: 'text',
    company: 'text',
    street: 'text',
    zipCode: 'text',
    city: 'text',
    email: 'email',
    phone: 'phone',
    login: 'text',
    pesel: 'text',
    note: 'text',
  },
}

export interface FakeHttpServer {
  /** The in-memory Channel behind the API; inspect its recorded pushes. */
  channel: FakeChannel
  /** `http://127.0.0.1:<port>` */
  origin: string
  /** A transport that sends the connector's requests for `https://fake-channel.example.test` to this server. */
  fetch: typeof fetch
  /** Every access token the server handed out (to prove none reached a cassette). */
  issuedTokens: string[]
  close(): Promise<void>
}

export interface FakeHttpServerOptions {
  clientId?: string
  clientSecret?: string
}

const context: FakeContext = { config: { failMode: 'none' }, credentials: { apiKey: 'server' }, fetch, log: () => {} }

function splitName(name: string) {
  const [firstName = '', ...rest] = name.split(' ')
  return { firstName, lastName: rest.join(' ') }
}

// The PESEL is the documented example number (an invented person), here so a recording has something to scrub.
function toApiOrder(order: Order): ApiOrder {
  return {
    id: order.externalId,
    createdAt: order.placedAt,
    paymentType: order.payment === 'prepaid' ? 'ONLINE' : 'CASH_ON_DELIVERY',
    awaitingPayment: order.awaitingPayment === true,
    total: order.total,
    buyer: {
      ...splitName(order.buyer.name),
      email: order.buyer.email,
      phone: order.buyer.phone ?? '+48 600 100 200',
      login: order.buyer.login,
      pesel: '44051401359',
    },
    delivery: {
      ...splitName(order.shippingAddress.name),
      company: order.shippingAddress.company,
      street: order.shippingAddress.street,
      zipCode: order.shippingAddress.postalCode,
      city: order.shippingAddress.city,
      countryCode: order.shippingAddress.countryCode,
      phone: order.shippingAddress.phone,
    },
    lines: order.lines.map((line) => ({
      id: line.externalId,
      offerId: line.offerExternalId,
      sku: line.sku,
      name: line.name,
      quantity: line.quantity,
      price: line.unitPrice,
    })),
    events: order.facts.map((fact) => ({
      id: fact.id,
      type: fact.type === 'shipped' ? 'SENT' : fact.type === 'paid' ? 'PAID' : 'CANCELLED',
      at: fact.occurredAt,
      note: fact.note,
    })),
  }
}

function jwtLike(): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: 'fake-seller', jti: randomBytes(8).toString('hex') })}.${randomBytes(16).toString('base64url')}`
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body))
}

/** The fake Channel's HTTP API on a random local port, backed by a fresh `createFakeChannel()`. */
export async function startFakeHttpServer(options: FakeHttpServerOptions = {}): Promise<FakeHttpServer> {
  const clientId = options.clientId ?? 'fake-http-client'
  const clientSecret = options.clientSecret ?? 'fake-http-client-secret'
  const channel = createFakeChannel({ id: 'fake-http-backend' })
  const { capabilities } = channel.connector
  const issuedTokens: string[] = []

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const body = await readBody(request)

    if (request.method === 'POST' && url.pathname === '/oauth/token') {
      const form = new URLSearchParams(body)
      if (form.get('client_id') !== clientId || form.get('client_secret') !== clientSecret) {
        return json(response, 401, { error: 'invalid_client' })
      }
      const token = jwtLike()
      issuedTokens.push(token)
      return json(response, 200, { access_token: token, token_type: 'Bearer', expires_in: 3600 }, {
        'set-cookie': `fake_session=${randomBytes(8).toString('hex')}; HttpOnly`,
      })
    }

    const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1]
    if (!token || !issuedTokens.includes(token)) return json(response, 401, { error: 'invalid_token' })
    const cursor = url.searchParams.get('cursor')

    if (request.method === 'GET' && url.pathname === '/offers') {
      const page = await capabilities['offers.pull']!(context, cursor)
      return json(response, 200, {
        offers: page.items.map((offer) => ({ id: offer.externalId, sku: offer.sku, title: offer.name, price: offer.price ?? null })),
        cursor: page.nextCursor,
        more: page.hasMore,
        // Some APIs echo the token in their links; the recorder must catch it there too.
        links: { self: `${FAKE_HTTP_BASE_URL}/offers?cursor=${cursor ?? ''}&access_token=${token}` },
      })
    }
    if (request.method === 'GET' && url.pathname === '/orders') {
      const page = await capabilities['orders.pull']!(context, cursor)
      return json(response, 200, { orders: page.items.map(toApiOrder), cursor: page.nextCursor, more: page.hasMore })
    }
    if (request.method === 'PUT' && url.pathname === '/stock') {
      const { items } = stockRequestSchema.parse(JSON.parse(body))
      await capabilities['stock.push']!(context, items.map((item) => ({ offerExternalId: item.offerId, sku: item.sku, available: item.quantity })))
      return response.writeHead(204).end()
    }
    const statusPath = /^\/orders\/([^/]+)\/status$/.exec(url.pathname)
    if (request.method === 'PUT' && statusPath) {
      const { status } = statusRequestSchema.parse(JSON.parse(body))
      const hanzaStatus = (Object.keys(API_STATUSES) as Array<keyof typeof API_STATUSES>).find((key) => API_STATUSES[key] === status)!
      await capabilities['orders.updateStatus']!(context, { orderExternalId: decodeURIComponent(statusPath[1]!), status: hanzaStatus })
      return response.writeHead(204).end()
    }
    return json(response, 404, { error: 'not_found' })
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: ConnectorError | Error) => json(response, 500, { error: error.message }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const base = new URL(FAKE_HTTP_BASE_URL).origin

  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.origin !== base) throw new TypeError(`The fake Channel server only answers ${base}, not ${url.origin}`)
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer()
    return fetch(`${origin}${url.pathname}${url.search}`, { method: request.method, headers: request.headers, body, signal: request.signal })
  }

  return {
    channel,
    origin,
    fetch: transport,
    issuedTokens,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        // fetch keeps connections alive; without this, close waits for them to time out.
        server.closeAllConnections()
      }),
  }
}
