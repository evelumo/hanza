import { z } from 'zod'

// DRAFT — the canonical model is designed in stage 1 (see docs/plan-architektury.html).

export const moneySchema = z.object({
  /** Decimal as a string, e.g. "129.99" — never a float. */
  amount: z.string().regex(/^-?\d+(\.\d+)?$/),
  currency: z.string().length(3),
})

export const orderLineSchema = z.object({
  externalId: z.string(),
  sku: z.string().nullable(),
  name: z.string(),
  quantity: z.number().int().positive(),
  unitPrice: moneySchema,
})

export const orderSchema = z.object({
  externalId: z.string(),
  status: z.enum(['new', 'paid', 'processing', 'shipped', 'cancelled']),
  placedAt: z.iso.datetime(),
  total: moneySchema,
  lines: z.array(orderLineSchema).min(1),
})

export type Money = z.infer<typeof moneySchema>
export type OrderLine = z.infer<typeof orderLineSchema>
export type Order = z.infer<typeof orderSchema>
