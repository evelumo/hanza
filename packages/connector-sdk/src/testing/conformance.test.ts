import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AnyConnectorDefinition } from '../connector'
import { AuthExpiredError, CursorExpiredError, PermanentError, errorFromResponse } from '../errors'
import type { Offer } from '../model/offer'
import type { OfferPrice } from '../model/price'
import type { ChannelFact, Order, OrderUpdate } from '../model/order'
import { assertConformance, type ConformanceFixtures } from './index'

const offers: Offer[] = [
  { externalId: 'o1', sku: 'SKU-1', name: 'Mug', url: null, price: { amount: '39.99', currency: 'PLN' } },
  { externalId: 'o2', sku: null, name: 'Poster', url: null, price: null },
  { externalId: 'o3', sku: 'SKU-3', name: 'Tote bag', url: null },
]

const order = (externalId: string): Order => ({
  externalId,
  placedAt: '2026-10-01T09:00:00Z',
  payment: 'prepaid',
  total: { amount: '10.00', currency: 'PLN' },
  buyer: { name: 'John', email: null, phone: null, login: null },
  shippingAddress: {
    name: 'John',
    company: null,
    street: '1 Test Street',
    postalCode: '00-001',
    city: 'Warsaw',
    countryCode: 'PL',
    phone: null,
    taxId: null,
  },
  billingAddress: null,
  lines: [
    {
      externalId: 'l1',
      offerExternalId: 'o1',
      sku: 'SKU-1',
      name: 'Mug',
      quantity: 1,
      unitPrice: { amount: '10.00', currency: 'PLN' },
    },
  ],
  facts: [],
})

const orders = [order('a'), order('b'), order('c')]

const fact = (id: string, type: ChannelFact['type'] = 'cancelled'): ChannelFact => ({ id, type, occurredAt: '2026-10-02T10:00:00Z', note: null })
const update = (externalId: string, facts: ChannelFact[], extra: Partial<OrderUpdate> = {}): OrderUpdate => ({ kind: 'update', externalId, facts, ...extra })

// Pages of two, cursor = offset; the minimal connector that satisfies every check.
function slice<T>(items: T[], cursor: string | null) {
  const start = cursor === null ? 0 : Number(cursor)
  const end = Math.min(start + 2, items.length)
  return { items: items.slice(start, end), nextCursor: String(end), hasMore: end < items.length }
}

function validConnector(overrides: Partial<AnyConnectorDefinition> = {}): AnyConnectorDefinition {
  return {
    id: 'minimal',
    name: 'Minimal',
    kind: 'marketplace',
    auth: { type: 'apiKey' },
    configSchema: z.object({ region: z.enum(['eu', 'us']).default('eu') }),
    credentialsSchema: z.object({ apiKey: z.string().min(1) }),
    capabilities: {
      'offers.pull': async (_ctx, cursor) => slice(offers, cursor),
      'orders.pull': async (ctx, cursor) => {
        if ((ctx.credentials as { apiKey: string }).apiKey === 'expired') throw new AuthExpiredError('expired')
        return slice(orders, cursor)
      },
      'stock.push': async () => {},
      'orders.updateStatus': async () => {},
      'price.push': async () => {},
    },
    ...overrides,
  }
}

const fixtures: ConformanceFixtures = {
  config: { region: 'eu' },
  credentials: { apiKey: 'test' },
  unauthorized: { credentials: { apiKey: 'expired' } },
}

function withCapabilities(capabilities: AnyConnectorDefinition['capabilities']) {
  return validConnector({ capabilities: { ...validConnector().capabilities, ...capabilities } })
}

// Pulls Orders over ctx.fetch, so C14's 403 reaches it; `options` is how it reads error responses.
function httpConnector(options: Parameters<typeof errorFromResponse>[1] = {}) {
  return withCapabilities({
    'orders.pull': async (ctx, cursor) => {
      const response = await ctx.fetch('https://example.invalid/orders')
      if (!response.ok) throw await errorFromResponse(response, options)
      return slice(orders, cursor)
    },
  })
}
const forbiddenIsAuth = httpConnector({ isAuthFailure: (response) => response.status === 403 })
const servingFetch = (async () => new Response('{}')) as typeof fetch

const broken: Array<[id: string, connector: AnyConnectorDefinition, fixtures?: ConformanceFixtures]> = [
  ['C1', validConnector({ id: 'Not A Slug' })],
  ['C1', validConnector({ name: '' })],
  ['C1', validConnector({ kind: 'warehouse' as never })],
  ['C1', validConnector({ auth: { type: 'basic' } as never })],
  ['C1', validConnector({ rateLimits: { application: { requests: 0, windowMs: 60_000 } } })],
  ['C1', validConnector({ rateLimits: { connection: { concurrency: 1.5 } } })],
  ['C2', validConnector(), { ...fixtures, credentials: {} }],
  ['C2', validConnector({ configSchema: z.object({ nested: z.object({ a: z.string() }) }) }), { ...fixtures, config: { nested: { a: 'x' } } }],
  ['C2', validConnector({ credentialsSchema: z.object({ apiKey: z.string().nullable() }) })],
  ['C3', validConnector({ capabilities: { ...validConnector().capabilities, 'stock.push': undefined } })],
  ['C4', withCapabilities({ 'offers.pull': async () => ({ items: [], nextCursor: null, hasMore: false }) })],
  ['C4', withCapabilities({ 'offers.pull': async () => ({ items: [{ ...offers[0]!, name: '' }], nextCursor: '1', hasMore: false }) })],
  ['C4', withCapabilities({ 'offers.pull': async () => ({ items: [offers[0]!, offers[0]!], nextCursor: '2', hasMore: false }) })],
  ['C4', withCapabilities({ 'offers.pull': async () => ({ items: [offers[0]!], nextCursor: null, hasMore: true }) })],
  ['C4', withCapabilities({ 'offers.pull': async (_ctx, cursor) => ({ items: [offers[0]!], nextCursor: cursor ?? 'x', hasMore: true }) })],
  ['C5', (() => {
    let run = 0
    return withCapabilities({
      'offers.pull': async (_ctx, cursor) => slice(run++ < 2 ? offers : [...offers].reverse(), cursor),
    })
  })()],
  ['C6', withCapabilities({ 'orders.pull': async () => ({ items: [], nextCursor: null, hasMore: false }) })],
  ['C6', withCapabilities({ 'orders.pull': async () => ({ items: [{ ...orders[0]!, lines: [] }], nextCursor: '1', hasMore: false }) })],
  ['C6', withCapabilities({
    'orders.pull': async () => {
      const bad = order('a')
      bad.lines[0]!.unitPrice.currency = 'EUR'
      return { items: [bad], nextCursor: '1', hasMore: false }
    },
  })],
  ['C6', withCapabilities({
    'orders.pull': async () => {
      const bad = order('a')
      bad.facts = [
        { id: 'f', type: 'cancelled', occurredAt: '2026-10-02T10:00:00Z', note: null },
        { id: 'f', type: 'shipped', occurredAt: '2026-10-03T10:00:00Z', note: null },
      ]
      return { items: [bad], nextCursor: '1', hasMore: false }
    },
  })],
  ['C6', withCapabilities({
    'orders.pull': async () => ({ items: [{ ...order('a'), payment: 'cash_on_delivery', awaitingPayment: true }], nextCursor: '1', hasMore: false }),
  })],
  ['C6', withCapabilities({
    'orders.pull': async () => {
      const bad: Order = { ...order('a'), awaitingPayment: true }
      bad.facts = [{ id: 'a:paid', type: 'paid', occurredAt: '2026-10-02T10:00:00Z', note: null }]
      return { items: [bad], nextCursor: '1', hasMore: false }
    },
  })],
  // The payment dropped from a later journal entry without a paid fact: Hanza would keep the Order awaiting payment.
  ['C6', withCapabilities({
    'orders.pull': async (_ctx, cursor) =>
      slice([{ ...order('a'), awaitingPayment: true }, order('b'), { ...order('a'), awaitingPayment: false }], cursor),
  })],
  ['C7', (() => {
    let calls = 0
    return withCapabilities({
      'orders.pull': async (_ctx, cursor) => slice(calls++ < 2 ? orders : [...orders].reverse(), cursor),
    })
  })()],
  ['C8', withCapabilities({ 'orders.pull': async (_ctx, cursor) => ({ ...slice(orders, cursor), hasMore: false }) })],
  ['C9', withCapabilities({ 'stock.push': async (_ctx, levels) => { if (levels.length === 0) throw new PermanentError('empty') } })],
  ['C9', withCapabilities({ 'stock.push': async (_ctx, levels) => { if (levels[0]?.available === 5) throw new PermanentError('five') } })],
  ['C9', withCapabilities({ 'stock.push': async () => [{ offerExternalId: 'unknown', outcome: 'ok' }] })],
  ['C9', withCapabilities({ 'stock.push': async (_ctx, levels) => levels.map((level) => ({ offerExternalId: level.offerExternalId, outcome: 'ended' as const })) })],
  ['C9', withCapabilities({ 'stock.push': async (_ctx, levels) => levels.map((level) => ({ offerExternalId: level.offerExternalId, outcome: 'rejected' as const, code: '' })) })],
  ['C9', withCapabilities({ 'stock.push': async (_ctx, levels) => [...levels, ...levels].map((level) => ({ offerExternalId: level.offerExternalId, outcome: 'ok' as const })) })],
  ['C4', withCapabilities({ 'offers.pull': async (_ctx, cursor) => slice(offers.map((offer) => ({ ...offer, status: 'active' as const, endedReason: 'sold_out' as const })), cursor) })],
  ['C10', withCapabilities({ 'orders.updateStatus': async (_ctx, input) => { if (input.phase === 'cancelled') throw new PermanentError('no') } })],
  ['C13', withCapabilities({ 'offers.pull': async (_ctx, cursor) => slice(offers.map((offer) => ({ ...offer, price: null })), cursor) })],
  ['C13', withCapabilities({ 'price.push': async (_ctx, prices) => { if (prices.length === 0) throw new PermanentError('empty') } })],
  ['C13', withCapabilities({ 'price.push': async (_ctx, prices) => prices.map((price) => ({ offerExternalId: price.offerExternalId, outcome: 'ended' as never })) })],
  ['C13', (() => {
    const seen = new Set<string>()
    return withCapabilities({
      'price.push': async (_ctx, prices) => {
        const key = JSON.stringify(prices)
        if (seen.has(key)) throw new PermanentError('not repeatable')
        seen.add(key)
      },
    })
  })()],
  ['C17', withCapabilities({ 'orders.pull': async (_ctx, cursor) => slice([...orders, { kind: 'update', externalId: 'a' } as never], cursor) })],
  ['C17', withCapabilities({ 'orders.pull': async (_ctx, cursor) => slice([...orders, update('a', [fact('a:x'), fact('a:x')])], cursor) })],
  ['C17', withCapabilities({
    'orders.pull': async (_ctx, cursor) => slice([...orders, update('a', [fact('a:x', 'paid')]), update('a', [fact('a:x', 'cancelled')])], cursor),
  })],
  ['C17', withCapabilities({
    'orders.pull': async (_ctx, cursor) => slice([{ ...order('a'), facts: [fact('a:1', 'shipped')] }, order('b'), update('a', [fact('a:1', 'cancelled')])], cursor),
  })],
  ['C7', (() => {
    let run = 0
    // The update's facts change between two pulls of the same cursor.
    return withCapabilities({ 'orders.pull': async (_ctx, cursor) => slice([...orders, update('x', [fact(`x:${run++}`)])], cursor) })
  })()],
  ['C18', validConnector(), { ...fixtures, expiredCursor: '0' }],
  // A journal connector needs the expired cursor fixture.
  ['C18', validConnector(), { ...fixtures, journal: true }],
  ['C18', withCapabilities({ 'orders.pull': async (_ctx, cursor) => {
    if (cursor === 'old') throw new PermanentError('gone')
    return slice(orders, cursor)
  } }), { ...fixtures, expiredCursor: 'old' }],
  ['C11', validConnector(), { ...fixtures, unauthorized: { credentials: { apiKey: 'also-fine' } } }],
  ['C11', withCapabilities({ 'orders.pull': async () => { throw new PermanentError('wrong kind') } })],
  ['C14', forbiddenIsAuth, { ...fixtures, unauthorized: undefined, fetch: servingFetch }],
  // Given recorded responses, but its pull never calls fetch: C14 would pass without seeing a 403.
  ['C14', validConnector(), { ...fixtures, fetch: servingFetch }],
  ['C12', withCapabilities({ 'stock.push': async () => { throw new Error('plain error') } })],
  ['C12', withCapabilities({ 'orders.pull': async () => { throw new Error('plain error') } })],
  ['C12', withCapabilities({ 'price.push': async () => { throw new Error('plain error') } })],
]

describe('assertConformance', () => {
  it('passes for a minimal valid connector', async () => {
    await expect(assertConformance(validConnector(), fixtures)).resolves.toBeUndefined()
  })

  it('passes for a connector that reports publication statuses and per-Offer results', async () => {
    const connector = withCapabilities({
      'offers.pull': async (_ctx, cursor) =>
        slice([{ ...offers[0]!, status: 'active' as const }, { ...offers[1]!, status: 'ended' as const, endedReason: 'sold_out' as const }, offers[2]!], cursor),
      'stock.push': async (_ctx, levels) =>
        levels.map((level, index) =>
          index === 0
            ? { offerExternalId: level.offerExternalId, outcome: 'rejected' as const, code: 'OFFER_NOT_FOUND' }
            : { offerExternalId: level.offerExternalId, outcome: level.available === 0 ? ('ended' as const) : ('ok' as const) },
        ),
      'price.push': async (_ctx, prices) => prices.map((price) => ({ offerExternalId: price.offerExternalId, outcome: 'rejected' as const, code: 'PRICE_TOO_LOW' })),
    })
    await expect(assertConformance(connector, fixtures)).resolves.toBeUndefined()
  })

  it('hands orders.updateStatus every Order phase as `phase`', async () => {
    const inputs: unknown[] = []
    const connector = withCapabilities({ 'orders.updateStatus': async (_ctx, input) => { inputs.push(input) } })
    await expect(assertConformance(connector, fixtures)).resolves.toBeUndefined()
    const phases = new Set(inputs.map((input) => (input as { phase: string }).phase))
    expect([...phases].sort()).toEqual(['cancelled', 'new', 'processing', 'shipped'])
    for (const input of inputs) expect(Object.keys(input as object).sort()).toEqual(['orderExternalId', 'phase'])
  })

  it('passes for a connector without orders.updateStatus and without an unauthorized fixture', async () => {
    const connector = validConnector({ capabilities: { ...validConnector().capabilities, 'orders.updateStatus': undefined } })
    await expect(assertConformance(connector, { config: { region: 'eu' }, credentials: { apiKey: 'test' } })).resolves.toBeUndefined()
  })

  it('passes for a connector that also reports unpaid Orders and their payment', async () => {
    const paid = { ...order('a'), awaitingPayment: false, facts: [{ id: 'a:paid', type: 'paid' as const, occurredAt: '2026-10-02T10:00:00Z', note: null }] }
    const cancelled = { ...order('b'), facts: [{ id: 'b:cancelled', type: 'cancelled' as const, occurredAt: '2026-10-02T10:00:00Z', note: null }] }
    // The journal: a and b arrive unpaid, a is paid later, b is cancelled and no longer flagged.
    const mixed = [{ ...order('a'), awaitingPayment: true }, { ...order('b'), awaitingPayment: true }, order('c'), paid, cancelled]
    const connector = withCapabilities({ 'orders.pull': async (_ctx, cursor) => slice(mixed, cursor) })
    await expect(assertConformance(connector, { config: { region: 'eu' }, credentials: { apiKey: 'test' } })).resolves.toBeUndefined()
  })

  it('passes for a connector that sends Order updates, also for Orders it never returned, and expires old cursors', async () => {
    const feed = [
      { ...order('a'), awaitingPayment: true },
      order('b'),
      // a is paid and its address arrives; z closed before the Connection, so Hanza never had it.
      update('a', [fact('a:paid', 'paid')], { shippingAddress: order('a').shippingAddress, billingAddress: null }),
      update('z', [fact('z:removed')]),
      update('b', []),
    ]
    const connector = withCapabilities({
      'orders.pull': async (_ctx, cursor) => {
        if (cursor === 'expired') throw new CursorExpiredError('older than the journal')
        return slice(feed, cursor)
      },
    })
    await expect(assertConformance(connector, { config: { region: 'eu' }, credentials: { apiKey: 'test' }, journal: true, expiredCursor: 'expired' })).resolves.toBeUndefined()
  })

  it('counts only full Orders for the "at least one Order" check', async () => {
    const connector = withCapabilities({ 'orders.pull': async (_ctx, cursor) => slice([update('a', [fact('a:x')])], cursor) })
    await expect(assertConformance(connector, fixtures)).rejects.toThrow(/\[C6\] orders.pull returned no Orders/)
  })

  it('passes for a connector without price.push whose Offers report no price', async () => {
    const connector = withCapabilities({
      'price.push': undefined,
      'offers.pull': async (_ctx, cursor) => slice(offers.map(({ price: _price, ...offer }) => offer), cursor),
    })
    await expect(assertConformance(connector, fixtures)).resolves.toBeUndefined()
  })

  it('pushes prices in the currency each Offer reports', async () => {
    const pushed: OfferPrice[][] = []
    const connector = withCapabilities({ 'price.push': async (_ctx, prices) => void pushed.push(prices) })
    await assertConformance(connector, fixtures)
    expect(pushed[0]).toEqual([])
    expect(pushed.slice(1).flat().every((price) => price.offerExternalId === 'o1' && price.price.currency === 'PLN')).toBe(true)
    expect(pushed.slice(1).map((prices) => prices[0]?.price.amount)).toEqual(['19.99', '19.99', '25', '25'])
  })

  it('skips Channel checks for a connector that is not a Channel', async () => {
    const courier = validConnector({ kind: 'courier', capabilities: {} })
    await expect(assertConformance(courier, { config: {}, credentials: { apiKey: 'test' } })).resolves.toBeUndefined()
  })

  it.each(broken)('%s fails for a broken connector', async (id, connector, override) => {
    const error = await assertConformance(connector, override ?? fixtures).then(
      () => null,
      (reason: unknown) => reason as Error,
    )
    expect(error, `expected ${id} to fail`).toBeInstanceOf(Error)
    expect(error!.message).toContain(`[${id}]`)
  })

  it('names the Order whose payment was dropped without a paid fact', async () => {
    const connector = withCapabilities({
      'orders.pull': async (_ctx, cursor) => slice([{ ...order('a'), awaitingPayment: true }, order('b'), order('a')], cursor),
    })
    await expect(assertConformance(connector, fixtures)).rejects.toThrow(
      /\[C6\] Order "a" was awaiting payment and is returned again without awaitingPayment but with no paid fact/,
    )
  })

  it('names every failure in one error', async () => {
    const connector = withCapabilities({
      'stock.push': async () => {
        throw new Error('plain error')
      },
      'orders.updateStatus': async () => {
        throw new PermanentError('no')
      },
    })
    const error = await assertConformance(connector, fixtures).catch((reason: Error) => reason)
    expect((error as Error).message).toMatch(/\[C9\][\s\S]*\[C10\][\s\S]*\[C12\]/)
  })

  it('refuses network access unless a fetch fixture is given', async () => {
    const calls: string[] = []
    const usesFetch = withCapabilities({
      'offers.pull': async (ctx, cursor) => {
        await ctx.fetch('https://example.invalid/offers')
        return slice(offers, cursor)
      },
    })
    await expect(assertConformance(usesFetch, fixtures)).rejects.toThrow(/network disabled in conformance tests/)
    const serving = async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input))
      return new Response('{}')
    }
    await expect(assertConformance(usesFetch, { ...fixtures, fetch: serving as typeof fetch })).resolves.toBeUndefined()
    expect(calls.length).toBeGreaterThan(0)
  })

  it('accepts a connector whose 403 is permanent, and one that opts out of C14 because its Channel signs out with 403', async () => {
    const httpFixtures: ConformanceFixtures = { ...fixtures, unauthorized: undefined, fetch: servingFetch }
    await expect(assertConformance(httpConnector(), httpFixtures)).resolves.toBeUndefined()
    await expect(assertConformance(forbiddenIsAuth, { ...httpFixtures, forbidden: false })).resolves.toBeUndefined()
  })

  it('accepts valid rate limits', async () => {
    const limited = validConnector({
      rateLimits: { application: { requests: 6000, windowMs: 60_000 }, connection: { rate: { requests: 10, windowMs: 1000 }, concurrency: 3 } },
    })
    await expect(assertConformance(limited, fixtures)).resolves.toBeUndefined()
  })

  it('stops a pull loop that never ends after maxPages', async () => {
    let counter = 0
    const endless = withCapabilities({
      'offers.pull': async () => ({ items: [{ ...offers[0]!, externalId: `o${counter}` }], nextCursor: String(++counter), hasMore: true }),
    })
    await expect(assertConformance(endless, { ...fixtures, maxPages: 3 })).rejects.toThrow(/\[C4\].*3 pages/)
  })
})
