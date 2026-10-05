import { z } from 'zod'
import { messageKey } from '@/i18n/keys'
import { idSchema, skuSchema, unitsSchema } from '@/lib/schemas'

const NAME_REQUIRED = messageKey('validation.nameRequired')
const OFFERS_REQUIRED = messageKey('validation.offersRequired')

export const productNameSchema = z.string({ error: NAME_REQUIRED }).trim().min(1, NAME_REQUIRED).max(200, messageKey('validation.productNameTooLong'))

export const createProductSchema = z.object({ sku: skuSchema, name: productNameSchema, stock: unitsSchema })
export const updateProductSchema = z.object({ productId: idSchema, name: productNameSchema })
export const setStockSchema = z.object({ productId: idSchema, warehouseId: idSchema, stock: unitsSchema })
export const unlinkOfferSchema = z.object({ offerId: idSchema })
export const linkOfferSchema = z.object({ offerId: idSchema, sku: skuSchema })
export const createProductsFromOffersSchema = z.object({
  offerIds: z.array(idSchema, { error: OFFERS_REQUIRED }).min(1, OFFERS_REQUIRED).max(200, messageKey('validation.offersTooMany')),
})
