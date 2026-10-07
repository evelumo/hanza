import {
  offerSchema,
  orderSchema,
  PermanentError,
  pricePushResultSchema,
  stockPushResultSchema,
  type Offer,
  type Order,
  type PricePushResult,
  type PullResult,
  type StockPushResult,
} from '@hanza/connector-sdk'
import { z } from 'zod'

const INT4_MAX = 2_147_483_647
const MAX_REPORTED_ISSUES = 5

/**
 * The canonical Order plus what storing it needs and the schema does not say: line ids unique
 * within the Order (a unique constraint) and quantities that fit an int4 column. Without these
 * checks such an Order failed inside the import, after the page had passed validation.
 */
const importableOrderSchema = orderSchema.superRefine((order, ctx) => {
  const seen = new Set<string>()
  order.lines.forEach((line, index) => {
    if (seen.has(line.externalId)) {
      ctx.addIssue({ code: 'custom', path: ['lines', index, 'externalId'], message: 'duplicates another line of the Order' })
    }
    seen.add(line.externalId)
    if (line.quantity > INT4_MAX) {
      ctx.addIssue({ code: 'custom', path: ['lines', index, 'quantity'], message: `is above ${INT4_MAX}` })
    }
  })
})

function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable(), hasMore: z.boolean() })
}

const offersPage = pageSchema(offerSchema)
const ordersPage = pageSchema(importableOrderSchema)

/** The item's external id when it has one; never other fields, which may hold Buyer data. */
function itemLabel(raw: unknown, index: number, noun: string): string {
  const items = (raw as { items?: unknown } | null)?.items
  const externalId = Array.isArray(items) ? (items[index] as { externalId?: unknown } | null)?.externalId : undefined
  return typeof externalId === 'string' ? `${noun} "${externalId.slice(0, 200)}"` : `${noun} #${index + 1}`
}

/** Paths and Zod's messages only: they name what is wrong, not the values. */
function describeIssues(error: z.ZodError, raw: unknown, noun: string): string {
  const parts = error.issues.map((issue) => {
    const [first, index, ...rest] = issue.path
    if (first === 'items' && typeof index === 'number') {
      return `${itemLabel(raw, index, noun)}: ${rest.length > 0 ? `${rest.map(String).join('.')} ` : ''}${issue.message}`
    }
    return `${issue.path.map(String).join('.') || 'page'}: ${issue.message}`
  })
  const unique = [...new Set(parts)]
  const shown = unique.slice(0, MAX_REPORTED_ISSUES).join('; ')
  const more = unique.length > MAX_REPORTED_ISSUES ? ` (and ${unique.length - MAX_REPORTED_ISSUES} more)` : ''
  return `The connector returned a page that breaks the contract: ${shown}${more}`
}

function parsePage<T>(schema: z.ZodType<PullResult<T>>, raw: unknown, cursor: string | null, noun: string): PullResult<T> {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw new PermanentError(describeIssues(parsed.error, raw, noun))
  const page = parsed.data
  // Calling again with the same cursor would return the same page forever.
  if (page.hasMore && (page.nextCursor === null || page.nextCursor === cursor)) {
    throw new PermanentError(
      `The connector broke the paging contract: hasMore is true but nextCursor is ${page.nextCursor === null ? 'null' : 'unchanged'}`,
    )
  }
  return page
}

/**
 * Validates a page of connector output like any external data. Every failure is a `PermanentError`
 * (a broken contract: output that fails the canonical schema), so call these inside `runConnectorCall`.
 */
export function parseOffersPage(raw: unknown, cursor: string | null): PullResult<Offer> {
  return parsePage(offersPage, raw, cursor, 'Offer')
}

export function parseOrdersPage(raw: unknown, cursor: string | null): PullResult<Order> {
  return parsePage(ordersPage, raw, cursor, 'Order')
}

function parsePushResults<T extends { offerExternalId: string; outcome: string }>(
  schema: z.ZodType<T>,
  raw: unknown,
  sent: Array<{ offerExternalId: string; available?: number }>,
  capability: string,
): Map<string, T> {
  const results = new Map<string, T>()
  // No results at all: every Offer of the call counts as pushed, as before per-Offer results existed.
  if (raw === undefined || raw === null) return results
  const parsed = z.array(schema).safeParse(raw)
  if (!parsed.success) {
    const paths = [...new Set(parsed.error.issues.map((issue) => `${issue.path.map(String).join('.') || 'results'}: ${issue.message}`))]
    throw new PermanentError(`${capability} returned results that break the contract: ${paths.slice(0, MAX_REPORTED_ISSUES).join('; ')}`)
  }
  const byId = new Map(sent.map((item) => [item.offerExternalId, item]))
  for (const result of parsed.data) {
    const item = byId.get(result.offerExternalId)
    const label = `Offer "${result.offerExternalId.slice(0, 200)}"`
    if (!item) throw new PermanentError(`${capability} returned a result for ${label}, which was not in the call`)
    if (results.has(result.offerExternalId)) throw new PermanentError(`${capability} returned two results for ${label}`)
    if (result.outcome === 'ended' && item.available !== 0) {
      throw new PermanentError(`${capability} reported ${label} ended after a number above 0`)
    }
    results.set(result.offerExternalId, result)
  }
  return results
}

/** Validates what `stock.push` returned, by Offer external id; Offers without a result were pushed. Failures are `PermanentError`s. */
export function parseStockPushResults(raw: unknown, levels: Array<{ offerExternalId: string; available: number }>): Map<string, StockPushResult> {
  return parsePushResults(stockPushResultSchema, raw, levels, 'stock.push')
}

/** Validates what `price.push` returned, by Offer external id; Offers without a result were pushed. Failures are `PermanentError`s. */
export function parsePricePushResults(raw: unknown, prices: Array<{ offerExternalId: string }>): Map<string, PricePushResult> {
  return parsePushResults(pricePushResultSchema, raw, prices, 'price.push')
}
