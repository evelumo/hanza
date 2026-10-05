import { z } from 'zod'

export const currencySchema = z.string().regex(/^[A-Z]{3}$/)

/** Decimal as a string, at most 15 integer and 4 fraction digits, e.g. "129.99". Never a float. */
export const moneySchema = z.object({
  amount: z.string().regex(/^\d{1,15}(\.\d{1,4})?$/),
  currency: currencySchema,
})

export type Money = z.infer<typeof moneySchema>
