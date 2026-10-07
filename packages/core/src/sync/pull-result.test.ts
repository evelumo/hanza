import { describe, expect, it } from 'vitest'
import { buildOrder, orderLine } from '../testing/fixtures'
import { parseOffersPage, parseOrdersPage, parsePricePushResults, parseStockPushResults } from './pull-result'

function failure(parse: () => unknown): Error {
  try {
    parse()
  } catch (error) {
    expect((error as { kind?: unknown }).kind).toBe('permanent')
    return error as Error
  }
  throw new Error('expected a failure')
}

describe('parseOrdersPage', () => {
  it('accepts a valid page', () => {
    const page = { items: [buildOrder()], nextCursor: '1', hasMore: true }
    expect(parseOrdersPage(page, null)).toEqual(page)
  })

  it('names the Order by its external id and the field, never the Buyer', () => {
    const order = { ...buildOrder({ externalId: 'ext-9' }), total: { amount: 1.5, currency: 'PLN' } }
    const error = failure(() => parseOrdersPage({ items: [buildOrder(), order], nextCursor: '1', hasMore: false }, null))
    expect(error.message).toContain('Order "ext-9": total.amount')
    expect(error.message).not.toMatch(/John|john\.test|Warsaw/)
  })

  it('falls back to the position when the item has no external id', () => {
    expect(failure(() => parseOrdersPage({ items: [{}], nextCursor: null, hasMore: false }, null)).message).toContain('Order #1')
  })

  it('rejects duplicate line ids within an Order and a quantity above the int4 maximum', () => {
    const duplicate = buildOrder({ externalId: 'dup', lines: [orderLine('a'), orderLine('b'), orderLine('a')] })
    expect(failure(() => parseOrdersPage({ items: [duplicate], nextCursor: '1', hasMore: false }, null)).message).toContain(
      'Order "dup": lines.2.externalId duplicates another line of the Order',
    )
    const huge = buildOrder({ externalId: 'huge', lines: [orderLine('a', { quantity: 2_147_483_648 })] })
    expect(failure(() => parseOrdersPage({ items: [huge], nextCursor: '1', hasMore: false }, null)).message).toContain(
      'Order "huge": lines.0.quantity is above 2147483647',
    )
    const max = buildOrder({ lines: [orderLine('a', { quantity: 2_147_483_647 })] })
    expect(() => parseOrdersPage({ items: [max], nextCursor: '1', hasMore: false }, null)).not.toThrow()
  })

  it('accepts Order updates next to Orders, and checks each item by its kind', () => {
    const fact = { id: 'a:paid', type: 'paid', occurredAt: '2026-10-02T10:00:00Z', note: null }
    const update = { kind: 'update', externalId: 'a', facts: [fact], billingAddress: null }
    const page = { items: [buildOrder({ externalId: 'a' }), update], nextCursor: '2', hasMore: false }
    expect(parseOrdersPage(page, null)).toEqual(page)

    const broken = { kind: 'update', externalId: 'u-1', facts: [{ ...fact, type: 'refunded' }], shippingAddress: { name: 'Jane Secret' } }
    const error = failure(() => parseOrdersPage({ items: [buildOrder(), broken], nextCursor: '2', hasMore: false }, null))
    expect(error.message).toContain('Order update "u-1": facts.0.type')
    expect(error.message).toContain('Order update "u-1": shippingAddress.street')
    expect(error.message).not.toContain('Jane Secret')
    // Without the kind it is a full Order, and is checked as one.
    expect(failure(() => parseOrdersPage({ items: [{ externalId: 'u-2', facts: [] }], nextCursor: '1', hasMore: false }, null)).message).toContain(
      'Order "u-2": placedAt',
    )
  })

  it('rejects hasMore without a new cursor; an empty last page may keep the cursor', () => {
    expect(failure(() => parseOrdersPage({ items: [], nextCursor: null, hasMore: true }, null)).message).toContain('paging contract')
    expect(failure(() => parseOrdersPage({ items: [], nextCursor: '4', hasMore: true }, '4')).message).toContain('paging contract')
    expect(parseOrdersPage({ items: [], nextCursor: '4', hasMore: false }, '4').hasMore).toBe(false)
  })
})

describe('parseOffersPage', () => {
  it('applies the same paging rule', () => {
    expect(failure(() => parseOffersPage({ items: [], nextCursor: '2', hasMore: true }, '2')).message).toContain('paging contract')
    expect(parseOffersPage({ items: [], nextCursor: '2', hasMore: true }, null).nextCursor).toBe('2')
  })
})

describe('push results', () => {
  const levels = [
    { offerExternalId: 'a', available: 0 },
    { offerExternalId: 'b', available: 3 },
  ]

  it('treats no results as every Offer pushed', () => {
    expect(parseStockPushResults(undefined, levels).size).toBe(0)
    expect(parseStockPushResults(null, levels).size).toBe(0)
    expect(parsePricePushResults(undefined, levels).size).toBe(0)
  })

  it('returns the results by Offer', () => {
    const results = parseStockPushResults(
      [
        { offerExternalId: 'a', outcome: 'ended' },
        { offerExternalId: 'b', outcome: 'rejected', code: 'OFFER_NOT_FOUND' },
      ],
      levels,
    )
    expect(results.get('a')).toEqual({ offerExternalId: 'a', outcome: 'ended' })
    expect(results.get('b')).toEqual({ offerExternalId: 'b', outcome: 'rejected', code: 'OFFER_NOT_FOUND' })
  })

  it('refuses results that break the contract, without echoing values', () => {
    expect(failure(() => parseStockPushResults([{ offerExternalId: 'b', outcome: 'ended' }], levels)).message).toMatch(/ended after a number above 0/)
    expect(failure(() => parseStockPushResults([{ offerExternalId: 'x', outcome: 'ok' }], levels)).message).toMatch(/not in the call/)
    expect(failure(() => parseStockPushResults([{ offerExternalId: 'a', outcome: 'ok' }, { offerExternalId: 'a', outcome: 'ok' }], levels)).message).toMatch(/two results/)
    expect(failure(() => parseStockPushResults({ rejected: [] }, levels)).message).toMatch(/break the contract/)
    expect(failure(() => parsePricePushResults([{ offerExternalId: 'a', outcome: 'ended' }], levels)).message).toMatch(/break the contract/)
    const secret = failure(() => parseStockPushResults([{ offerExternalId: 'a', outcome: 'rejected', code: 'x'.repeat(500) }], levels))
    expect(secret.message).not.toContain('x'.repeat(101))
  })
})
