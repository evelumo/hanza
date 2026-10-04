import { describe, expect, it } from 'vitest'
import { addConnectionSchema, requestSyncSchema } from './schemas'

describe('addConnectionSchema', () => {
  it('trims the name and limits it to 100 characters', () => {
    expect(addConnectionSchema.parse({ connectorId: 'fake', name: '  Kanał testowy ' }).name).toBe('Kanał testowy')
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
