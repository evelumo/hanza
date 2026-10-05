import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AnyConnectorDefinition } from '../connector'
import { AuthExpiredError, PermanentError } from '../errors'
import type { Offer } from '../model/offer'
import type { Order } from '../model/order'
import { assertConformance, type ConformanceFixtures } from './index'

const offers: Offer[] = [
  { externalId: 'o1', sku: 'SKU-1', name: 'Mug', url: null },
  { externalId: 'o2', sku: null, name: 'Poster', url: null },
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

const broken: Array<[id: string, connector: AnyConnectorDefinition, fixtures?: ConformanceFixtures]> = [
  ['C1', validConnector({ id: 'Not A Slug' })],
  ['C1', validConnector({ name: '' })],
  ['C1', validConnector({ kind: 'warehouse' as never })],
  ['C1', validConnector({ auth: { type: 'basic' } as never })],
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
  ['C7', (() => {
    let calls = 0
    return withCapabilities({
      'orders.pull': async (_ctx, cursor) => slice(calls++ < 2 ? orders : [...orders].reverse(), cursor),
    })
  })()],
  ['C8', withCapabilities({ 'orders.pull': async (_ctx, cursor) => ({ ...slice(orders, cursor), hasMore: false }) })],
  ['C9', withCapabilities({ 'stock.push': async (_ctx, levels) => { if (levels.length === 0) throw new PermanentError('empty') } })],
  ['C9', withCapabilities({ 'stock.push': async (_ctx, levels) => { if (levels[0]?.available === 5) throw new PermanentError('five') } })],
  ['C10', withCapabilities({ 'orders.updateStatus': async (_ctx, input) => { if (input.status === 'cancelled') throw new PermanentError('no') } })],
  ['C11', validConnector(), { ...fixtures, unauthorized: { credentials: { apiKey: 'also-fine' } } }],
  ['C11', withCapabilities({ 'orders.pull': async () => { throw new PermanentError('wrong kind') } })],
  ['C12', withCapabilities({ 'stock.push': async () => { throw new Error('plain error') } })],
  ['C12', withCapabilities({ 'orders.pull': async () => { throw new Error('plain error') } })],
]

describe('assertConformance', () => {
  it('passes for a minimal valid connector', async () => {
    await expect(assertConformance(validConnector(), fixtures)).resolves.toBeUndefined()
  })

  it('passes for a connector without orders.updateStatus and without an unauthorized fixture', async () => {
    const connector = validConnector({ capabilities: { ...validConnector().capabilities, 'orders.updateStatus': undefined } })
    await expect(assertConformance(connector, { config: { region: 'eu' }, credentials: { apiKey: 'test' } })).resolves.toBeUndefined()
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

  it('stops a pull loop that never ends after maxPages', async () => {
    let counter = 0
    const endless = withCapabilities({
      'offers.pull': async () => ({ items: [{ ...offers[0]!, externalId: `o${counter}` }], nextCursor: String(++counter), hasMore: true }),
    })
    await expect(assertConformance(endless, { ...fixtures, maxPages: 3 })).rejects.toThrow(/\[C4\].*3 pages/)
  })
})
