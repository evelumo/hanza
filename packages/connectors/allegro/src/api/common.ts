import { z } from 'zod'
import type { ZodError } from 'zod'

// Allegro's `Price`: the amount is a string on purpose (no rounding); kept as text until it reaches `moneySchema`.
export const allegroPriceSchema = z.object({
  amount: z.string(),
  currency: z.string(),
})
export type AllegroPrice = z.infer<typeof allegroPriceSchema>

/** Allegro dates are ISO 8601 in UTC (`2018-10-12T10:12:32.321Z`); an offset is accepted too. */
export const allegroDateTime = z.iso.datetime({ offset: true })

/** Allegro's `ExternalId`: the seller's own id of an Offer (the SKU), at most 100 characters. */
export const allegroExternalIdSchema = z.object({
  id: z.string().nullish(),
})

/**
 * An enum field of an Allegro response. Parsed as any string so that a value Allegro adds later does not fail the
 * whole page; the mappers compare against the known values and treat anything else as unknown.
 */
export const allegroEnum = z.string()

const PATH_SEGMENT = /^[A-Za-z0-9_]{1,64}$/
const MAX_ISSUES = 10

/**
 * The distinct issue paths of a failed parse, for an error message: never a value or a zod message, which could quote
 * a token or Buyer data. Keys that are not plain identifiers (a record's keys come from the body) show as `?`.
 */
export function issuePaths(error: ZodError): string {
  const paths = error.issues.map((issue) =>
    issue.path.length === 0
      ? '(root)'
      : issue.path.map((segment) => (typeof segment === 'number' ? String(segment) : PATH_SEGMENT.test(String(segment)) ? String(segment) : '?')).join('.'),
  )
  const distinct = [...new Set(paths)]
  return distinct.length > MAX_ISSUES ? `${distinct.slice(0, MAX_ISSUES).join(', ')}, …` : distinct.join(', ')
}
