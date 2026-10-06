import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { describeFailure } from './describe-failure'

describe('describeFailure', () => {
  it('keeps the name, the code and the last line of a message', () => {
    const error = Object.assign(new Error('Invalid `prisma.order.create()` invocation:\n{ buyerName: "Anna" }\nUnique constraint failed'), {
      code: 'P2002',
    })
    expect(describeFailure(error)).toBe('Error P2002: Unique constraint failed')
  })

  it('describes a ZodError by its issue paths and codes, never the values', () => {
    const schema = z.object({ shippingAddress: z.object({ countryCode: z.string().regex(/^[A-Z]{2}$/), city: z.string() }) })
    const parsed = schema.safeParse({ shippingAddress: { countryCode: 'Warszawa Anny Nowak', city: 7 } })
    const text = describeFailure(parsed.error)
    expect(text).toBe('ZodError: shippingAddress.countryCode invalid_format; shippingAddress.city invalid_type')
    expect(text).not.toMatch(/Anny|Warszawa/)
  })

  it('names a non-error', () => {
    expect(describeFailure('boom')).toBe('Unexpected failure')
  })
})
