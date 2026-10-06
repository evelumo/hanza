import { describe, expect, it } from 'vitest'
import { createWarehouseSchema, setWarehouseActiveSchema, updateWarehouseSchema } from './schemas'

describe('createWarehouseSchema', () => {
  it('trims the name and reads an empty priority as "put it last"', () => {
    expect(createWarehouseSchema.parse({ name: ' North ', priority: '' })).toEqual({ name: 'North', priority: null })
    expect(createWarehouseSchema.parse({ name: 'North', priority: ' 3 ' })).toEqual({ name: 'North', priority: 3 })
  })

  it('refuses an empty or too long name and a priority that is not a whole number from 0', () => {
    expect(createWarehouseSchema.safeParse({ name: ' ', priority: '' }).success).toBe(false)
    expect(createWarehouseSchema.safeParse({ name: 'x'.repeat(101), priority: '' }).success).toBe(false)
    for (const priority of ['-1', '1.5', 'abc', '1000001']) {
      expect(createWarehouseSchema.safeParse({ name: 'North', priority }).success).toBe(false)
    }
  })
})

describe('updateWarehouseSchema', () => {
  it('needs a priority', () => {
    expect(updateWarehouseSchema.parse({ warehouseId: 'w', name: 'North', priority: '0' })).toEqual({ warehouseId: 'w', name: 'North', priority: 0 })
    expect(updateWarehouseSchema.safeParse({ warehouseId: 'w', name: 'North', priority: '' }).success).toBe(false)
  })
})

describe('setWarehouseActiveSchema', () => {
  it('reads "true" and "false" only', () => {
    expect(setWarehouseActiveSchema.parse({ warehouseId: 'w', active: 'false' })).toEqual({ warehouseId: 'w', active: false })
    expect(setWarehouseActiveSchema.parse({ warehouseId: 'w', active: 'true' })).toEqual({ warehouseId: 'w', active: true })
    expect(setWarehouseActiveSchema.safeParse({ warehouseId: 'w', active: 'yes' }).success).toBe(false)
  })
})
