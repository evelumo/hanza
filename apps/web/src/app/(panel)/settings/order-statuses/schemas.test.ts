import { describe, expect, it } from 'vitest'
import {
  createOrderStatusSchema,
  deleteOrderStatusSchema,
  moveOrderStatusSchema,
  setOrderStatusActiveSchema,
  updateOrderStatusSchema,
} from './schemas'

describe('createOrderStatusSchema', () => {
  it('needs a phase and a trimmed name of at most 60 characters; an empty colour is the phase colour', () => {
    expect(createOrderStatusSchema.parse({ phase: 'processing', name: '  Packing ', color: '' })).toEqual({ phase: 'processing', name: 'Packing', color: null })
    expect(createOrderStatusSchema.parse({ phase: 'new', name: 'x'.repeat(60), color: 'violet' }).color).toBe('violet')
    expect(createOrderStatusSchema.safeParse({ phase: 'new', name: 'x'.repeat(61), color: '' }).success).toBe(false)
    expect(createOrderStatusSchema.safeParse({ phase: 'new', name: '   ', color: '' }).success).toBe(false)
    expect(createOrderStatusSchema.safeParse({ phase: 'delivered', name: 'Delivered', color: '' }).success).toBe(false)
    expect(createOrderStatusSchema.safeParse({ phase: 'new', name: 'X', color: 'pink' }).success).toBe(false)
  })
})

describe('updateOrderStatusSchema', () => {
  it('turns an empty name into the phase name (null)', () => {
    expect(updateOrderStatusSchema.parse({ statusId: 's', name: '  ', color: '' })).toEqual({ statusId: 's', name: null, color: null })
    expect(updateOrderStatusSchema.parse({ statusId: 's', name: ' Packed ', color: 'teal' })).toEqual({ statusId: 's', name: 'Packed', color: 'teal' })
  })
})

describe('the other status forms', () => {
  it('accept only their own values', () => {
    expect(moveOrderStatusSchema.safeParse({ statusId: 's', direction: 'up' }).success).toBe(true)
    expect(moveOrderStatusSchema.safeParse({ statusId: 's', direction: 'left' }).success).toBe(false)
    expect(setOrderStatusActiveSchema.parse({ statusId: 's', active: '0' }).active).toBe(false)
    expect(setOrderStatusActiveSchema.parse({ statusId: 's', active: '1' }).active).toBe(true)
    expect(deleteOrderStatusSchema.parse({ statusId: 's' }).replacementId).toBeNull()
    expect(deleteOrderStatusSchema.parse({ statusId: 's', replacementId: '' }).replacementId).toBeNull()
    expect(deleteOrderStatusSchema.parse({ statusId: 's', replacementId: 'r' }).replacementId).toBe('r')
  })
})
