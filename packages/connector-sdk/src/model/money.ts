import { z } from 'zod'

export const currencySchema = z.string().regex(/^[A-Z]{3}$/)

/** Decimal as a string, at most 15 integer and 4 fraction digits, e.g. "129.99". Never a float. */
export const moneySchema = z.object({
  amount: z.string().regex(/^\d{1,15}(\.\d{1,4})?$/),
  currency: currencySchema,
})

export type Money = z.infer<typeof moneySchema>

// ISO 4217 minor units of the currencies that do not use 2. A fixed table on purpose: Intl's data follows the
// ICU/CLDR version (e.g. some versions report 0 decimals for HUF and IDR, which ISO gives 2), and a runtime
// upgrade must not change which amounts Hanza accepts.
const MINOR_UNITS: Readonly<Record<string, number>> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0,
  UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  CLF: 4, UYW: 4,
}

/** Decimal places a currency uses (its ISO 4217 minor units, e.g. 2 for PLN, 0 for JPY, 3 for KWD); 2 for any other code. */
export function currencyMinorUnits(currency: string): number {
  return Object.hasOwn(MINOR_UNITS, currency) ? MINOR_UNITS[currency]! : 2
}
