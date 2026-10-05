import { z } from 'zod'
import { messageKey } from '@/i18n/keys'

// Messages are catalogue keys, not text: `invalidInput` translates them for the request's locale.
const ID_MESSAGE = messageKey('validation.idInvalid')
const SKU_REQUIRED = messageKey('validation.skuRequired')
const UNITS_MESSAGE = messageKey('validation.unitsInvalid')
const PRICE_MESSAGE = messageKey('validation.priceInvalid')
const CURRENCY_MESSAGE = messageKey('validation.currencyInvalid')

/** Ids come from hidden fields, so the message is for the logs more than for the user. */
export const idSchema = z.string({ error: ID_MESSAGE }).min(1, ID_MESSAGE).max(64, ID_MESSAGE)

export const skuSchema = z.string({ error: SKU_REQUIRED }).trim().min(1, SKU_REQUIRED).max(64, messageKey('validation.skuTooLong'))

/** Stock units from a text input; `z.coerce.number()` would turn an empty field into 0. */
export const unitsSchema = z
  .string({ error: UNITS_MESSAGE })
  .trim()
  .regex(/^\d{1,7}$/, UNITS_MESSAGE)
  .transform(Number)
  .pipe(z.number().max(1_000_000, UNITS_MESSAGE))

/**
 * A price amount from a text input, kept a decimal string (never a float): a comma is read as the decimal
 * separator, at most 15 integer and 4 fraction digits, above zero.
 */
export const priceAmountSchema = z
  .string({ error: PRICE_MESSAGE })
  .trim()
  .transform((value) => value.replace(',', '.'))
  .pipe(
    z
      .string()
      .regex(/^\d{1,15}(\.\d{1,4})?$/, PRICE_MESSAGE)
      .refine((value) => /[1-9]/.test(value), PRICE_MESSAGE),
  )

/** ISO 4217 code, upper-cased: "pln" is read as "PLN". */
export const currencyCodeSchema = z.string({ error: CURRENCY_MESSAGE }).trim().toUpperCase().regex(/^[A-Z]{3}$/, CURRENCY_MESSAGE)
