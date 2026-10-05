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
    expect(orderListFiltersSchema.parse({ phase: 'bogus', status: '', attention: 'yes' })).toEqual({ phase: undefined, status: undefined, attention: undefined })
    expect(orderListFiltersSchema.parse({ phase: 'shipped', status: 'status-id', attention: '1' })).toEqual({ phase: 'shipped', status: 'status-id', attention: '1' })
    expect(orderListFiltersSchema.parse({})).toEqual({})
  })
})
