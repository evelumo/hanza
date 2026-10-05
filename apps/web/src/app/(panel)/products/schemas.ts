import { z } from 'zod'
import { messageKey } from '@/i18n/keys'
import { currencyCodeSchema, idSchema, priceAmountSchema, skuSchema, unitsSchema } from '@/lib/schemas'

const NAME_REQUIRED = messageKey('validation.nameRequired')
const OFFERS_REQUIRED = messageKey('validation.offersRequired')
const FIELD_INVALID = messageKey('validation.fieldInvalid')

export const productNameSchema = z.string({ error: NAME_REQUIRED }).trim().min(1, NAME_REQUIRED).max(200, messageKey('validation.productNameTooLong'))

export const createProductSchema = z.object({ sku: skuSchema, name: productNameSchema, stock: unitsSchema })
export const updateProductSchema = z.object({ productId: idSchema, name: productNameSchema })
export const setStockSchema = z.object({ productId: idSchema, stock: unitsSchema })
export const unlinkOfferSchema = z.object({ offerId: idSchema })
export const linkOfferSchema = z.object({ offerId: idSchema, sku: skuSchema })
export const createProductsFromOffersSchema = z.object({
  offerIds: z.array(idSchema, { error: OFFERS_REQUIRED }).min(1, OFFERS_REQUIRED).max(200, messageKey('validation.offersTooMany')),
})

/** The price form's two buttons: `set` saves the amount and currency, `clear` removes the price. */
function priceFormSchema<K extends string>(idField: K) {
  const id = { [idField]: idSchema } as Record<K, typeof idSchema>
  return z.discriminatedUnion(
    'intent',
    [
      z.object({ ...id, intent: z.literal('set'), amount: priceAmountSchema, currency: currencyCodeSchema }),
      z.object({ ...id, intent: z.literal('clear') }),
    ],
    { error: FIELD_INVALID },
  )
}

export const setBasePriceSchema = priceFormSchema('productId')
export const setOfferPriceSchema = priceFormSchema('offerId')

/** The price a parsed price form asks for; null removes it. */
export function priceFromForm(data: { intent: 'set'; amount: string; currency: string } | { intent: 'clear' }) {
  return data.intent === 'set' ? { amount: data.amount, currency: data.currency } : null
}
