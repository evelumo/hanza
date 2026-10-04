import { z } from 'zod'

// DRAFT — see order.ts.

export const stockLevelSchema = z.object({
  sku: z.string(),
  available: z.number().int().nonnegative(),
})

export type StockLevel = z.infer<typeof stockLevelSchema>
