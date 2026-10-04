import { z } from 'zod'
import { idSchema, skuSchema, unitsSchema } from '@/lib/schemas'

export const productNameSchema = z.string().trim().min(1, 'Podaj nazwę.').max(200, 'Nazwa może mieć najwyżej 200 znaków.')

export const createProductSchema = z.object({ sku: skuSchema, name: productNameSchema, stock: unitsSchema })
export const updateProductSchema = z.object({ productId: idSchema, name: productNameSchema })
export const setStockSchema = z.object({ productId: idSchema, stock: unitsSchema })
export const unlinkOfferSchema = z.object({ offerId: idSchema })
export const linkOfferSchema = z.object({ offerId: idSchema, sku: skuSchema })
export const createProductsFromOffersSchema = z.object({
  offerIds: z.array(idSchema).min(1, 'Zaznacz co najmniej jedną ofertę.').max(200, 'Zaznacz najwyżej 200 ofert naraz.'),
})
