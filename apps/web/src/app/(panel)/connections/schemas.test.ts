import { describe, expect, it } from 'vitest'
import { addConnectionSchema, requestSyncSchema, statusMappingSchema } from './schemas'

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
