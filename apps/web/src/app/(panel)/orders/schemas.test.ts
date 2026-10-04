import { describe, expect, it } from 'vitest'
import { changeOrderStatusSchema, linkOrderLineSchema, orderListFiltersSchema, resolveAttentionSchema } from './schemas'

describe('changeOrderStatusSchema', () => {
  it('accepts only the four Order statuses', () => {
    for (const status of ['new', 'processing', 'shipped', 'cancelled']) {
      expect(changeOrderStatusSchema.safeParse({ orderId: 'o', status }).success).toBe(true)
    }
    expect(changeOrderStatusSchema.safeParse({ orderId: 'o', status: 'delivered' }).success).toBe(false)
    expect(changeOrderStatusSchema.safeParse({ orderId: 'o' }).success).toBe(false)
    expect(changeOrderStatusSchema.safeParse({ orderId: '', status: 'new' }).success).toBe(false)
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
    expect(orderListFiltersSchema.parse({ status: 'bogus', attention: 'yes' })).toEqual({ status: undefined, attention: undefined })
    expect(orderListFiltersSchema.parse({ status: 'shipped', attention: '1' })).toEqual({ status: 'shipped', attention: '1' })
    expect(orderListFiltersSchema.parse({})).toEqual({})
  })
})
