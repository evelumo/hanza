import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { changeOrderStatusSchema, linkOrderLineSchema } from '@/app/(panel)/orders/schemas'
import { addConnectionSchema, statusMappingSchema } from '@/app/(panel)/connections/schemas'
import {
  createOrderStatusSchema,
  deleteOrderStatusSchema,
  moveOrderStatusSchema,
  setOrderStatusActiveSchema,
  updateOrderStatusSchema,
} from '@/app/(panel)/settings/order-statuses/schemas'
import { createProductSchema, createProductsFromOffersSchema, linkOfferSchema, setStockSchema } from '@/app/(panel)/products/schemas'
import { catalogues } from '@/i18n/catalogues'
import { translatorFor } from '@/i18n/testing'
import { isMessageKey } from '@/i18n/keys'
import { invalidInput } from './action-state'
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
  const garbage = [{}, { orderId: 'a'.repeat(99) }, { orderId: 1, productId: 1, offerId: 1, offerIds: 'x', status: 'zzz', statusId: 1, phase: 'zzz', color: 'pink', direction: 'left', active: 'yes', replacementId: 1, new: 1, sku: 1, stock: 1, name: 1, orderLineId: 1, connectorId: 1 }]
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
    createOrderStatusSchema,
    updateOrderStatusSchema,
    moveOrderStatusSchema,
    setOrderStatusActiveSchema,
    deleteOrderStatusSchema,
    statusMappingSchema,
  }

  // Field messages end up in the action state, and so possibly on screen, so each must be a catalogue key
  // that `invalidInput` can translate; zod's own defaults are English text.
  it.each(Object.entries(schemas))('%s only reports catalogue keys', (_name, schema) => {
    for (const input of garbage) {
      const result = schema.safeParse(input)
      if (result.success) continue
      for (const issue of result.error.issues) expect(isMessageKey(issue.message), `${issue.path.join('.')}: ${issue.message}`).toBe(true)
    }
  })

  it('translates the field messages for the locale of the request', () => {
    const result = createProductSchema.safeParse({ sku: ' ', name: '', stock: 'x' })
    if (result.success) throw new Error('expected a failure')
    expect(invalidInput(result.error, translatorFor('en')).fieldErrors).toEqual({
      sku: 'Enter a SKU.',
      name: 'Enter a name.',
      stock: 'Enter a whole number from 0 to 1,000,000.',
    })
    expect(invalidInput(result.error, translatorFor('pl'))).toMatchObject({
      error: catalogues.pl.errors.invalidInput,
      fieldErrors: { sku: catalogues.pl.validation.skuRequired, name: catalogues.pl.validation.nameRequired },
    })
    expect(catalogues.pl.validation.skuRequired).not.toBe(catalogues.en.validation.skuRequired)
  })

  it('shows a generic message for an issue that is not a catalogue key', () => {
    const result = z.object({ x: z.string() }).safeParse({ x: 1 })
    if (result.success) throw new Error('expected a failure')
    expect(invalidInput(result.error, translatorFor('en')).fieldErrors).toEqual({ x: 'Check the fields.' })
  })
})
