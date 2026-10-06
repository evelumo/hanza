import { z } from 'zod'
import { moneySchema } from './money'

/** What Hanza tells a Channel about one Offer's price: its effective price, in the currency the Channel reported for it. */
export const offerPriceSchema = z.object({
  offerExternalId: z.string().min(1),
  sku: z.string().min(1).nullable(),
  price: moneySchema,
})

export type OfferPrice = z.infer<typeof offerPriceSchema>
