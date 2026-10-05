import { describe, expect, it } from 'vitest'
import { buildOrder, orderLine } from '../testing/fixtures'
import { parseOffersPage, parseOrdersPage } from './pull-result'

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
