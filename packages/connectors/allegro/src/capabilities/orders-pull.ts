import { CursorExpiredError, type Order, type OrderUpdate, type PullResult } from '@hanza/connector-sdk'
import { errorsHolderSchema } from '../api/errors'
import { orderEventsPageSchema, orderEventStatsSchema } from '../api/events'
import { checkoutFormSchema, checkoutFormsPageSchema, type CheckoutForm } from '../api/orders'
import { concurrently, failureOf, parse, readJson, request, send, type AllegroContext } from '../client'
import { decodeCursor, encodeCursor, type OrdersCursor } from '../cursor'
import { boundaryKeyOf, hasUsableAddress, isOneFulfillment, mapOrder, mapOrderUpdate, removedOrderUpdate } from '../mapping/order'

/** Checkout forms per listing page: the API's maximum. */
export const LISTING_PAGE_SIZE = 100
/** Events per journal page. */
export const JOURNAL_PAGE_SIZE = 100
/** `GET /order/checkout-forms/{id}` requests in flight at once. */
export const CHECKOUT_FORM_CONCURRENCY = 3
/** How old an Order open at the start of the feed may be and still be listed (purchase time before the boundary). */
export const LISTING_WINDOW_DAYS = 30
/** Fulfillment statuses of an Order that is no longer open: shipped, collected, or cancelled by the seller. */
export const CLOSED_FULFILLMENT_STATUSES: readonly string[] = ['SENT', 'PICKED_UP', 'CANCELLED']

type FeedItem = Order | OrderUpdate
type ListingCursor = Extract<OrdersCursor, { phase: 'listing' }>
type JournalCursor = Extract<OrdersCursor, { phase: 'journal' }>

const DAY_MS = 86_400_000
// `GET /order/events` answers taken as an expired journal position when the request carried `from`.
const CURSOR_EXPIRED_STATUSES: readonly number[] = [400, 404, 422]
// A checkout form the Buyer has not finished yet: in the journal, without an address it comes again on a later event.
const AWAITING_CHECKOUT: readonly string[] = ['BOUGHT', 'FILLED_IN']

function time(value: string): number {
  return Date.parse(value)
}

/** Open on Allegro now: not cancelled, not shipped or collected, and not fulfilled by Allegro itself. */
function isOpen(form: CheckoutForm): boolean {
  return form.status !== 'CANCELLED' && !CLOSED_FULFILLMENT_STATUSES.includes(form.fulfillment?.status ?? '') && !isOneFulfillment(form)
}

/**
 * The form as a full Order, or, when it has no address to ship to at all, as an Order update: `orderSchema` needs a
 * shipping address (an SDK limit, issue #101). The update is applied only to an Order the core already has.
 */
function fullOrderOf(ctx: AllegroContext, form: CheckoutForm): FeedItem {
  if (hasUsableAddress(form)) return mapOrder(form)
  ctx.log('Allegro checkout form has no address to ship to; sent as an Order update', { checkoutFormId: form.id })
  return mapOrderUpdate(form)
}

/**
 * The time the feed starts, from Allegro's `Date` header: the boundary is compared with Allegro's purchase times, so
 * its clock is the one that counts (a skewed local clock would move Orders across the boundary). The local clock
 * only when the header is missing or unreadable.
 */
function serverTimeOf(response: Response): string {
  const date = Date.parse(response.headers.get('date') ?? '')
  return new Date(Number.isNaN(date) ? Date.now() : date).toISOString()
}

/**
 * One page of the Orders open now, placed before the boundary and at most `LISTING_WINDOW_DAYS` before it, by keyset
 * on the purchase time. `status` and `fulfillment.status` are single-valued on this resource, so the open ones are
 * picked here, not in the query.
 */
async function listingPage(ctx: AllegroContext, cursor: ListingCursor): Promise<PullResult<FeedItem>> {
  const windowStart = new Date(time(cursor.boughtBefore) - LISTING_WINDOW_DAYS * DAY_MS).toISOString()
  const from = cursor.lastBoughtAt !== null && time(cursor.lastBoughtAt) > time(windowStart) ? cursor.lastBoughtAt : windowStart
  const response = await send(ctx, '/order/checkout-forms', {
    query: {
      limit: String(LISTING_PAGE_SIZE),
      sort: 'lineItems.boughtAt',
      'lineItems.boughtAt.lte': cursor.boughtBefore,
      'lineItems.boughtAt.gte': from,
    },
  })
  const forms = (await parse(response, checkoutFormsPageSchema, 'Order list')).checkoutForms
  const items = forms.filter(isOpen).map((form) => fullOrderOf(ctx, form))

  let lastKey: string | null = null
  for (const form of forms) {
    const key = boundaryKeyOf(form)
    if (lastKey === null || time(key) > time(lastKey)) lastKey = key
  }
  // `gte` repeats the forms that share the last key (harmless). A full page whose key did not move would repeat
  // itself for ever, so it ends the listing too.
  const moved = lastKey !== null && (cursor.lastBoughtAt === null || time(lastKey) > time(cursor.lastBoughtAt))
  const next: OrdersCursor =
    forms.length >= LISTING_PAGE_SIZE && moved
      ? { ...cursor, lastBoughtAt: lastKey }
      : { phase: 'journal', eventId: cursor.eventId, boughtBefore: cursor.boughtBefore }
  return { items, nextCursor: encodeCursor(next), hasMore: true }
}

/** The items for one form of the journal; a 404 means it was merged into another one and is gone. */
async function journalItemsOf(ctx: AllegroContext, formId: string, boughtBefore: string, occurredAt: string): Promise<FeedItem[]> {
  const response = await request(ctx, `/order/checkout-forms/${encodeURIComponent(formId)}`)
  if (response.status === 404) {
    await response.body?.cancel().catch(() => {})
    return [removedOrderUpdate(formId, occurredAt)]
  }
  if (!response.ok) throw await failureOf(response)
  const form = await parse(response, checkoutFormSchema, 'Order')
  if (isOneFulfillment(form)) return []
  if (!hasUsableAddress(form) && AWAITING_CHECKOUT.includes(form.status)) return []
  // Full Orders only after the boundary: an Order placed before it was either listed, or closed before the feed started.
  if (time(boundaryKeyOf(form)) <= time(boughtBefore)) return [mapOrderUpdate(form)]
  const order = fullOrderOf(ctx, form)
  // The core takes addresses only from an update (a full Order it already has adds only facts): once paid, the
  // delivery address replaces the account address the unpaid Order was imported with.
  if (!('kind' in order) && form.status === 'READY_FOR_PROCESSING') return [order, mapOrderUpdate(form)]
  return [order]
}

/** Whether a failed `GET /order/events` says the journal no longer has the position (an Allegro error body). */
async function isExpiredPosition(response: Response): Promise<boolean> {
  if (!CURSOR_EXPIRED_STATUSES.includes(response.status)) return false
  const body = errorsHolderSchema.safeParse(await readJson(response.clone(), 'order event journal error'))
  return body.success && body.data.errors.some((error) => error.code !== '')
}

/** One page of the order event journal, from the cursor's position. */
async function journalPage(ctx: AllegroContext, cursor: JournalCursor, cursorText: string): Promise<PullResult<FeedItem>> {
  const response = await request(ctx, '/order/events', {
    query: { from: cursor.eventId ?? undefined, limit: String(JOURNAL_PAGE_SIZE) },
  })
  if (!response.ok) {
    // How Allegro answers a `from` it no longer keeps (60 days) is not documented: any of these with an error body.
    // Safe to read broadly: the core fails permanently on a second CursorExpiredError in one run, or one for cursor
    // null, so a query that is wrong for another reason cannot loop. Without `from` there is no position to lose.
    if (cursor.eventId !== null && (await isExpiredPosition(response))) {
      await response.body?.cancel().catch(() => {})
      throw new CursorExpiredError(`${response.status}: the Allegro order event journal no longer has the cursor's position`)
    }
    throw await failureOf(response)
  }
  const { events } = await parse(response, orderEventsPageSchema, 'order event journal')
  if (events.length === 0) return { items: [], nextCursor: cursorText, hasMore: false }

  // Distinct forms in page order; the removed fact takes the time of the form's last event on the page.
  const lastEventAt = new Map<string, string>()
  for (const event of events) {
    const formId = event.order.checkoutForm?.id
    if (formId) lastEventAt.set(formId, event.occurredAt)
  }
  const formIds = [...lastEventAt.keys()]
  const items = await concurrently(formIds, CHECKOUT_FORM_CONCURRENCY, (formId) =>
    journalItemsOf(ctx, formId, cursor.boughtBefore, lastEventAt.get(formId)!),
  )
  const last = events[events.length - 1]!
  return {
    items: items.flat(),
    nextCursor: encodeCursor({ phase: 'journal', eventId: last.id, boughtBefore: cursor.boughtBefore }),
    hasMore: events.length >= JOURNAL_PAGE_SIZE,
  }
}

/**
 * The Order feed (ADR 0021). Cursor null takes the journal position (`GET /order/event-stats`) first and the
 * boundary (`boughtBefore` = Allegro's time of that answer) second, then lists the Orders open now placed before the
 * boundary, then follows the journal from that position. Both stay in every cursor: `l1:` while listing, `e1:` in the
 * journal.
 */
export async function pullOrders(ctx: AllegroContext, cursorText: string | null): Promise<PullResult<FeedItem>> {
  if (cursorText === null) {
    const response = await send(ctx, '/order/event-stats')
    const boughtBefore = serverTimeOf(response)
    const stats = await parse(response, orderEventStatsSchema, 'order event stats')
    return listingPage(ctx, { phase: 'listing', eventId: stats.latestEvent?.id ?? null, boughtBefore, lastBoughtAt: null })
  }
  const cursor = decodeCursor(cursorText)
  return cursor.phase === 'listing' ? listingPage(ctx, cursor) : journalPage(ctx, cursor, cursorText)
}
