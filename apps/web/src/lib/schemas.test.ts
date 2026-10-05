import { describe, expect, it } from 'vitest'
import { changeOrderStatusSchema, linkOrderLineSchema } from '@/app/(panel)/orders/schemas'
import { addConnectionSchema } from '@/app/(panel)/connections/schemas'
import { createProductSchema, createProductsFromOffersSchema, linkOfferSchema, setStockSchema } from '@/app/(panel)/products/schemas'
import { idSchema, skuSchema, unitsSchema } from './schemas'

describe('idSchema', () => {
  it('accepts ids up to 64 characters and rejects empty, longer and non-string values', () => {
    expect(idSchema.safeParse('a'.repeat(64)).success).toBe(true)
    expect(idSchema.safeParse('').success).toBe(false)
    expect(idSchema.safeParse('a'.repeat(65)).success).toBe(false)
    expect(idSchema.safeParse('a'.repeat(200_000)).success).toBe(false)
    expect(idSchema.safeParse(undefined).success).toBe(false)
  })
})

describe('validation messages', () => {
  const garbage = [{}, { orderId: 'a'.repeat(99) }, { orderId: 1, productId: 1, offerId: 1, offerIds: 'x', status: 'zzz', sku: 1, stock: 1, name: 1, orderLineId: 1, connectorId: 1 }]
  const schemas = {
    idSchema,
    skuSchema,
    unitsSchema,
    changeOrderStatusSchema,
    linkOrderLineSchema,
    addConnectionSchema,
    createProductSchema,
    setStockSchema,
    linkOfferSchema,
    createProductsFromOffersSchema,
  }

  // Field messages end up in the action state, and so possibly on screen; zod's own defaults are English.
  // (Whole-input issues have no field and are dropped by `invalidInput`.)
  it.each(Object.entries(schemas))('%s never reports a zod default message', (_name, schema) => {
    for (const input of garbage) {
      const result = schema.safeParse(input)
      if (result.success) continue
      for (const issue of result.error.issues) expect(issue.message).not.toMatch(/Invalid|Too (big|small)|expected|Required/i)
    }
  })
})
