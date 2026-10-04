import { z } from 'zod'

export const offerSchema = z.object({
  externalId: z.string().min(1),
  sku: z.string().min(1).nullable(),
  name: z.string().min(1),
  url: z.url().nullable(),
})

export type Offer = z.infer<typeof offerSchema>
