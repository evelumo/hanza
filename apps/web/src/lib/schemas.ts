import { z } from 'zod'

const ID_MESSAGE = 'Nieprawidłowy identyfikator.'

/** Ids come from hidden fields, so the message is for the logs more than for the user; it must still never be English. */
export const idSchema = z.string({ error: ID_MESSAGE }).min(1, ID_MESSAGE).max(64, ID_MESSAGE)

export const skuSchema = z.string({ error: 'Podaj SKU.' }).trim().min(1, 'Podaj SKU.').max(64, 'SKU może mieć najwyżej 64 znaki.')

const UNITS_MESSAGE = 'Podaj liczbę całkowitą od 0 do 1 000 000.'

/** Stock units from a text input; `z.coerce.number()` would turn an empty field into 0. */
export const unitsSchema = z
  .string({ error: UNITS_MESSAGE })
  .trim()
  .regex(/^\d{1,7}$/, UNITS_MESSAGE)
  .transform(Number)
  .pipe(z.number().max(1_000_000, UNITS_MESSAGE))
