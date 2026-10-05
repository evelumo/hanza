import { z } from 'zod'

/** What Hanza tells a Channel about one Offer: max(0, Available) of its Product. */
export const stockLevelSchema = z.object({
  offerExternalId: z.string().min(1),
  sku: z.string().min(1).nullable(),
  available: z.number().int().nonnegative(),
})

export type StockLevel = z.infer<typeof stockLevelSchema>
