import { describe, expect, it } from 'vitest'
import { addConnectionSchema, requestSyncSchema, stockRulesSchema } from './schemas'

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
  it('reads whole numbers and an empty or missing limit as no limit', () => {
    expect(stockRulesSchema.parse({ connectionId: 'c', safetyBuffer: ' 2 ', channelLimit: '5' })).toEqual({
      connectionId: 'c',
      safetyBuffer: 2,
      channelLimit: 5,
    })
    expect(stockRulesSchema.parse({ connectionId: 'c', safetyBuffer: '0', channelLimit: '  ' }).channelLimit).toBeNull()
    expect(stockRulesSchema.parse({ connectionId: 'c', safetyBuffer: '0' }).channelLimit).toBeNull()
    expect(stockRulesSchema.parse({ connectionId: 'c', safetyBuffer: '0', channelLimit: '0' }).channelLimit).toBe(0)
  })

  it('rejects an empty buffer, negative, fractional and too large values', () => {
    for (const [safetyBuffer, channelLimit] of [['', ''], ['-1', ''], ['1.5', ''], ['1000001', ''], ['0', '-1'], ['0', '2.5'], ['0', '1000001'], ['0', 'x']]) {
      expect(stockRulesSchema.safeParse({ connectionId: 'c', safetyBuffer, channelLimit }).success).toBe(false)
    }
  })
})
