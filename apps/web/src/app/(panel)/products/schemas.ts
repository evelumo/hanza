import { z } from 'zod'
import { messageKey } from '@/i18n/keys'
import { parsePriceInput } from '@/lib/price-input'
import { currencyCodeSchema, idSchema, skuSchema, unitsSchema } from '@/lib/schemas'

const NAME_REQUIRED = messageKey('validation.nameRequired')
const OFFERS_REQUIRED = messageKey('validation.offersRequired')
const FIELD_INVALID = messageKey('validation.fieldInvalid')
const PRICE_INVALID = messageKey('validation.priceInvalid')

export const productNameSchema = z.string({ error: NAME_REQUIRED }).trim().min(1, NAME_REQUIRED).max(200, messageKey('validation.productNameTooLong'))

export const createProductSchema = z.object({ sku: skuSchema, name: productNameSchema, stock: unitsSchema })
export const updateProductSchema = z.object({ productId: idSchema, name: productNameSchema })
export const setStockSchema = z.object({ productId: idSchema, warehouseId: idSchema, stock: unitsSchema })
export const unlinkOfferSchema = z.object({ offerId: idSchema })
export const linkOfferSchema = z.object({ offerId: idSchema, sku: skuSchema })
export const retryOfferPushSchema = z.object({ offerId: idSchema, push: z.enum(['stock', 'price'], { error: FIELD_INVALID }) })
export const createProductsFromOffersSchema = z.object({
  offerIds: z.array(idSchema, { error: OFFERS_REQUIRED }).min(1, OFFERS_REQUIRED).max(200, messageKey('validation.offersTooMany')),
})

type PriceForm = { intent: 'set'; amount: string; currency: string } | { intent: 'clear' }

/** Reads the amount for its currency (`parsePriceInput`); runs only once the currency is valid. */
function readPrice<T extends PriceForm>(data: T, ctx: z.RefinementCtx): T {
  if (data.intent === 'clear') return data
  const read = parsePriceInput(data.amount, data.currency)
  if ('error' in read) {
    ctx.addIssue({ code: 'custom', path: ['amount'], message: read.error })
    return z.NEVER
  }
  return { ...data, amount: read.amount }
}

// The price form's two buttons: `set` saves the amount and currency, `clear` removes the price.
const setPrice = { intent: z.literal('set'), amount: z.string({ error: PRICE_INVALID }), currency: currencyCodeSchema }
const clearPrice = { intent: z.literal('clear') }

export const setBasePriceSchema = z
  .discriminatedUnion('intent', [z.object({ productId: idSchema, ...setPrice }), z.object({ productId: idSchema, ...clearPrice })], {
    error: FIELD_INVALID,
  })
  .transform(readPrice)
export const setOfferPriceSchema = z
  .discriminatedUnion('intent', [z.object({ offerId: idSchema, ...setPrice }), z.object({ offerId: idSchema, ...clearPrice })], {
    error: FIELD_INVALID,
  })
  .transform(readPrice)

/** The price a parsed price form asks for; null removes it. */
export function priceFromForm(data: PriceForm) {
  return data.intent === 'set' ? { amount: data.amount, currency: data.currency } : null
}
