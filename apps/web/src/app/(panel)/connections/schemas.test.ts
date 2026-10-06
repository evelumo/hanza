import { describe, expect, it } from 'vitest'
import { addConnectionSchema, channelWarehousesSchema, requestSyncSchema, statusMappingSchema, stockRulesSchema } from './schemas'

describe('channelWarehousesSchema', () => {
  it('reads "all" without Warehouses', () => {
    expect(channelWarehousesSchema.parse({ connectionId: 'c', mode: 'all', warehouseIds: ['w'] })).toEqual({ connectionId: 'c', mode: 'all' })
  })

  it('reads "only" with at least one Warehouse', () => {
    expect(channelWarehousesSchema.parse({ connectionId: 'c', mode: 'only', warehouseIds: ['a', 'b'] })).toEqual({
      connectionId: 'c',
      mode: 'only',
      warehouseIds: ['a', 'b'],
    })
    const empty = channelWarehousesSchema.safeParse({ connectionId: 'c', mode: 'only', warehouseIds: [] })
    expect(empty.success).toBe(false)
    expect(empty.error?.issues[0]?.message).toBe('validation.warehousesRequired')
  })

  it('refuses an unknown mode, a missing connection or an empty id', () => {
    expect(channelWarehousesSchema.safeParse({ connectionId: 'c', mode: 'some', warehouseIds: ['a'] }).success).toBe(false)
    expect(channelWarehousesSchema.safeParse({ mode: 'all' }).success).toBe(false)
    expect(channelWarehousesSchema.safeParse({ connectionId: 'c', mode: 'only', warehouseIds: [''] }).success).toBe(false)
  })
})

describe('addConnectionSchema', () => {
  it('trims the name and limits it to 100 characters', () => {
    expect(addConnectionSchema.parse({ connectorId: 'fake', name: '  Test channel ' }).name).toBe('Test channel')
    expect(addConnectionSchema.safeParse({ connectorId: 'fake', name: '   ' }).success).toBe(false)
    expect(addConnectionSchema.safeParse({ connectorId: 'fake', name: 'x'.repeat(101) }).success).toBe(false)
    expect(addConnectionSchema.safeParse({ connectorId: 'fake', name: 'x'.repeat(100) }).success).toBe(true)
  })

  it('needs a connector id', () => {
    expect(addConnectionSchema.safeParse({ connectorId: '', name: 'x' }).success).toBe(false)
  })
})

describe('requestSyncSchema', () => {
  it('needs a connection id', () => {
    expect(requestSyncSchema.safeParse({ connectionId: 'c' }).success).toBe(true)
    expect(requestSyncSchema.safeParse({}).success).toBe(false)
  })
})

describe('stockRulesSchema', () => {
  it('reads whole numbers, and an empty limit as no limit', () => {
    expect(stockRulesSchema.parse({ connectionId: 'c', safetyBuffer: ' 2 ', channelLimit: '5' })).toEqual({
      connectionId: 'c',
      safetyBuffer: 2,
      channelLimit: 5,
    })
    expect(stockRulesSchema.parse({ connectionId: 'c', safetyBuffer: '0', channelLimit: '  ' }).channelLimit).toBeNull()
    expect(stockRulesSchema.parse({ connectionId: 'c', safetyBuffer: '0', channelLimit: '0' }).channelLimit).toBe(0)
  })

  it('fails closed: a missing limit field is an error, not "no limit"', () => {
    const missing = stockRulesSchema.safeParse({ connectionId: 'c', safetyBuffer: '0' })
    expect(missing.success).toBe(false)
    expect(missing.error?.issues[0]?.path).toEqual(['channelLimit'])
    expect(stockRulesSchema.safeParse({ connectionId: 'c', safetyBuffer: '0', channelLimit: null }).success).toBe(false)
    expect(stockRulesSchema.safeParse({ connectionId: 'c', channelLimit: '' }).success).toBe(false)
  })

  it('rejects an empty buffer, negative, fractional and too large values', () => {
    for (const [safetyBuffer, channelLimit] of [['', ''], ['-1', ''], ['1.5', ''], ['1000001', ''], ['0', '-1'], ['0', '2.5'], ['0', '1000001'], ['0', 'x']]) {
      expect(stockRulesSchema.safeParse({ connectionId: 'c', safetyBuffer, channelLimit }).success).toBe(false)
    }
  })
})

describe('statusMappingSchema', () => {
  it('turns an empty choice into the phase default and needs every reported phase', () => {
    expect(statusMappingSchema.parse({ connectionId: 'c', new: '', shipped: 's', cancelled: '' })).toEqual({
      connectionId: 'c',
      new: null,
      shipped: 's',
      cancelled: null,
    })
    expect(statusMappingSchema.safeParse({ connectionId: 'c', new: '' }).success).toBe(false)
    expect(statusMappingSchema.safeParse({ connectionId: 'c', new: 'x'.repeat(65), shipped: '', cancelled: '' }).success).toBe(false)
  })
})
