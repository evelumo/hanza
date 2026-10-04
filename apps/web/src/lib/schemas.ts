import { z } from 'zod'

export const idSchema = z.string().min(1)

export const skuSchema = z.string().trim().min(1, 'Podaj SKU.').max(64, 'SKU może mieć najwyżej 64 znaki.')

const UNITS_MESSAGE = 'Podaj liczbę całkowitą od 0 do 1 000 000.'

/** Stock units from a text input; `z.coerce.number()` would turn an empty field into 0. */
export const unitsSchema = z
  .string()
  .trim()
  .regex(/^\d{1,7}$/, UNITS_MESSAGE)
  .transform(Number)
  .pipe(z.number().max(1_000_000, UNITS_MESSAGE))
