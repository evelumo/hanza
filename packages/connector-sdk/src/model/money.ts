import { z } from 'zod'

export const currencySchema = z.string().regex(/^[A-Z]{3}$/)

/** Decimal as a string, at most 15 integer and 4 fraction digits, e.g. "129.99". Never a float. */
export const moneySchema = z.object({
  amount: z.string().regex(/^\d{1,15}(\.\d{1,4})?$/),
  currency: currencySchema,
})

export type Money = z.infer<typeof moneySchema>

/**
 * Decimal places a currency uses (its ISO 4217 minor units, e.g. 2 for PLN, 0 for JPY, 3 for KWD), as the runtime's
 * Intl data knows them; 2 for a code Intl does not know.
 */
export function currencyMinorUnits(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
  } catch {
    return 2
  }
}
