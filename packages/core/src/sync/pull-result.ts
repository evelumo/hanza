import {
  offerSchema,
  orderSchema,
  orderUpdateSchema,
  PermanentError,
  type Offer,
  type OrderFeedItem,
  type PullResult,
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

/** An item with `kind: 'update'` is checked as an Order update, anything else as a full Order, so errors name the right fields. */
const orderFeedItemSchema = z.unknown().transform((value, ctx): OrderFeedItem => {
  const isUpdate = typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'update'
  const parsed = (isUpdate ? orderUpdateSchema : importableOrderSchema).safeParse(value)
  if (parsed.success) return parsed.data
  for (const issue of parsed.error.issues) ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path })
  return z.NEVER
})

const offersPage = pageSchema(offerSchema)
const ordersPage = pageSchema(orderFeedItemSchema)

/** The item's external id when it has one; never other fields, which may hold Buyer data. */
function itemLabel(raw: unknown, index: number, noun: string): string {
  const items = (raw as { items?: unknown } | null)?.items
  const item = Array.isArray(items) ? (items[index] as { externalId?: unknown; kind?: unknown } | null) : undefined
  const externalId = item?.externalId
  const label = item?.kind === 'update' ? `${noun} update` : noun
  return typeof externalId === 'string' ? `${label} "${externalId.slice(0, 200)}"` : `${label} #${index + 1}`
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

export function parseOrdersPage(raw: unknown, cursor: string | null): PullResult<OrderFeedItem> {
  return parsePage(ordersPage, raw, cursor, 'Order')
}
