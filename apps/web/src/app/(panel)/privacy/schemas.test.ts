import { describe, expect, it } from 'vitest'
import { erasureSchema, retentionSchema } from './schemas'

describe('retentionSchema', () => {
  it('reads whole days from 1 to 3650, and an empty field as off', () => {
    expect(retentionSchema.parse({ retentionDays: ' 30 ' })).toEqual({ retentionDays: 30 })
    expect(retentionSchema.parse({ retentionDays: '3650' })).toEqual({ retentionDays: 3650 })
    expect(retentionSchema.parse({ retentionDays: '' })).toEqual({ retentionDays: null })
    expect(retentionSchema.parse({ retentionDays: '  ' })).toEqual({ retentionDays: null })
  })

  it('reads the confirmation flag only when it is exactly 1', () => {
    expect(retentionSchema.parse({ retentionDays: '30', confirmed: '1' })).toEqual({ retentionDays: 30, confirmed: '1' })
    expect(retentionSchema.parse({ retentionDays: '30', confirmed: 'yes' })).toEqual({ retentionDays: 30 })
  })

  it('refuses anything else with the catalogue message', () => {
    for (const retentionDays of ['0', '3651', '-1', '1.5', 'ten', '99999']) {
      const parsed = retentionSchema.safeParse({ retentionDays })
      expect(parsed.success, retentionDays).toBe(false)
      expect(parsed.error?.issues[0]?.message).toBe('validation.retentionDaysInvalid')
    }
    expect(retentionSchema.safeParse({}).success).toBe(false)
  })
})

describe('erasureSchema', () => {
  it('trims the email and accepts what Channels really store', () => {
    expect(erasureSchema.parse({ email: '  anna@example.com ' })).toEqual({ email: 'anna@example.com' })
    for (const email of ['josé@example.com', 'user@localhost', 'j_hn+tag@example.com', 'A.B@EXAMPLE.PL']) {
      expect(erasureSchema.safeParse({ email }).success, email).toBe(true)
    }
  })

  it('refuses what cannot be an email, with the catalogue message', () => {
    for (const email of ['', 'anna', '@', 'anna@', '@example.com', `${'a'.repeat(320)}@example.com`]) {
      const parsed = erasureSchema.safeParse({ email })
      expect(parsed.success, email).toBe(false)
      expect(parsed.error?.issues[0]?.message).toBe('validation.emailInvalid')
    }
  })
})
