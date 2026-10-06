import { z } from 'zod'
import { moneySchema } from './money'

export const offerSchema = z.object({
  externalId: z.string().min(1),
  sku: z.string().min(1).nullable(),
  name: z.string().min(1),
  url: z.url().nullable(),
  /**
   * The Offer's current price on the Channel, as the Channel reports it; null or omitted when unknown.
   * Hanza owns the price (ADR 0011): this only tells it the Channel's currency and is never adopted.
   */
  price: moneySchema.nullable().optional(),
})

export type Offer = z.infer<typeof offerSchema>
