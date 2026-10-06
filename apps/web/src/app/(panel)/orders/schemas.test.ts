import { describe, expect, it } from 'vitest'
import { changeOrderStatusSchema, linkOrderLineSchema, orderListFiltersSchema, resolveAttentionSchema } from './schemas'

describe('changeOrderStatusSchema', () => {
  it('needs an order id and a status id', () => {
    expect(changeOrderStatusSchema.safeParse({ orderId: 'o', statusId: 's' }).success).toBe(true)
    expect(changeOrderStatusSchema.safeParse({ orderId: 'o' }).success).toBe(false)
    expect(changeOrderStatusSchema.safeParse({ orderId: '', statusId: 's' }).success).toBe(false)
    expect(changeOrderStatusSchema.safeParse({ orderId: 'o', statusId: 'x'.repeat(65) }).success).toBe(false)
  })
})

describe('linkOrderLineSchema', () => {
  it('needs a line id and a trimmed SKU', () => {
    expect(linkOrderLineSchema.parse({ orderLineId: 'l', sku: ' UNKNOWN-SKU ' }).sku).toBe('UNKNOWN-SKU')
    expect(linkOrderLineSchema.safeParse({ orderLineId: 'l', sku: ' ' }).success).toBe(false)
    expect(linkOrderLineSchema.safeParse({ sku: 'x' }).success).toBe(false)
  })
})

describe('resolveAttentionSchema', () => {
  it('needs an order id', () => {
    expect(resolveAttentionSchema.safeParse({ orderId: 'o' }).success).toBe(true)
    expect(resolveAttentionSchema.safeParse({}).success).toBe(false)
  })
})

describe('orderListFiltersSchema', () => {
  it('ignores filter values it does not know instead of failing the page', () => {
    expect(orderListFiltersSchema.parse({ phase: 'bogus', status: '', attention: 'yes', payment: 'paid' })).toEqual({
      phase: undefined,
      status: undefined,
      attention: undefined,
      payment: undefined,
    })
    expect(orderListFiltersSchema.parse({ phase: 'shipped', status: 'status-id', attention: '1', payment: 'awaiting' })).toEqual({
      phase: 'shipped',
      status: 'status-id',
      attention: '1',
      payment: 'awaiting',
    })
    expect(orderListFiltersSchema.parse({})).toEqual({})
  })

  it('reads a phase in `status` (links from before Order statuses) as the phase filter', () => {
    expect(orderListFiltersSchema.parse({ status: 'shipped' })).toEqual({ phase: 'shipped', status: undefined })
    expect(orderListFiltersSchema.parse({ phase: 'new', status: 'cancelled', attention: '1' })).toEqual({ phase: 'new', status: undefined, attention: '1' })
    expect(orderListFiltersSchema.parse({ status: 'new', payment: 'awaiting' })).toEqual({ phase: 'new', status: undefined, payment: 'awaiting' })
  })
})
