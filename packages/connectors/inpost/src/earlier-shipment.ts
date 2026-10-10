import { PermanentError, TransientError, type ShipmentRequest } from '@hanza/connector-sdk'
import type { ShipxShipment } from './api'
import { listShipments, PAGE_SIZE } from './client'
import type { InpostContext } from './config'

/**
 * How far before `requestedAt` the search starts. `requestedAt` is Hanza's clock and `created_at` InPost's: with
 * Hanza's ahead by more than this, the earlier shipment falls outside the search and the repeat posts again.
 */
export const SEARCH_MARGIN_SECONDS = 60 * 60
/**
 * How far this server's clock may be from the `Date` of InPost's answer. Far below the margin, so the margin also
 * covers what cannot be checked here: a `requestedAt` stamped by another machine than the one that asks.
 */
export const MAX_CLOCK_DIFFERENCE_MS = 5 * 60_000
/** 2000 shipments in the window. More means a seller this search cannot serve or a filter ShipX ignored: either way, stop. */
export const MAX_SEARCH_PAGES = 20

const INCONSISTENT = 'InPost listed fewer shipments than it counts since this Shipment was requested, so an earlier attempt cannot be ruled out and no new one was sent'

function clockProblem(serverTime: number | null): PermanentError | null {
  // No `Date` to compare with (a replayed cassette keeps none; InPost always sends one): the margin stands alone.
  if (serverTime === null) return null
  const difference = Math.abs(Date.now() - serverTime)
  if (difference <= MAX_CLOCK_DIFFERENCE_MS) return null
  return new PermanentError(
    `The clock of this Hanza server is ${Math.round(difference / 60_000)} minutes away from InPost's, so the search for an earlier attempt cannot be trusted and no shipment was sent; set the server's clock`,
  )
}

/**
 * The shipment an earlier `shipments.create` made for this request, or null when there is none.
 *
 * ShipX has no idempotency key and cannot filter by `reference`, and in simplified mode it buys the label within
 * seconds of the `POST`. So a create first lists what the organization made since an hour before Hanza first asked
 * (`requestedAt`, the same on every repeat) and compares references. Oldest first: shipments made meanwhile only
 * append, so a page does not shift under the search.
 *
 * "None" is an answer only when the listing was read to its end: as many shipments seen as ShipX counts, and the
 * two clocks in agreement. Anything short of that throws, and the caller posts nothing.
 *
 * What it cannot see: a shipment younger than the listing's lag (up to 5.4 s after its `POST`, see AGENTS.md). The
 * core does not repeat a create whose outcome it does not know sooner than 5 minutes after the earlier call began.
 *
 * The one place that knows how a repeat is found.
 */
export async function findEarlierShipment(ctx: InpostContext, request: Pick<ShipmentRequest, 'reference' | 'requestedAt'>): Promise<ShipxShipment | null> {
  // A Unix time, which ShipX takes like ISO 8601 (the sandbox answered both the same): no offset to encode or misread.
  const since = Math.floor(Date.parse(request.requestedAt) / 1000) - SEARCH_MARGIN_SECONDS
  if (!Number.isFinite(since)) throw new PermanentError('The Shipment request has no readable requestedAt, so an earlier attempt cannot be looked for')
  const query = { created_at_gteq: String(since), sort_by: 'created_at', sort_order: 'asc' }
  const seen = new Set<string>()
  // The highest count of any page: a count that drops while the pages are read (a shipment was cancelled, and ShipX
  // lists cancelled shipments nowhere) means the pages shifted, and one shipment may have slipped between two.
  let counted = 0
  let serverTime: number | null = null
  for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
    const list = await listShipments(ctx, query, page)
    if (page === 1) serverTime = list.serverTime
    const earlier = list.items.find((shipment) => shipment.reference === request.reference)
    if (earlier) return earlier
    const before = seen.size
    for (const shipment of list.items) seen.add(shipment.id)
    counted = Math.max(counted, list.count)
    if (seen.size >= counted) {
      const problem = clockProblem(serverTime)
      if (problem) throw problem
      return null
    }
    // Not at the end by ShipX's own count, and this page was short, empty or a repeat: the listing contradicts
    // itself, which a moment later it may not. The page size ShipX echoes is not asked: it echoes what was sent.
    if (list.items.length < PAGE_SIZE || seen.size === before) throw new TransientError(INCONSISTENT)
  }
  // Never post blindly: a second paid parcel is worse than a Shipment that waits for a person.
  throw new PermanentError(
    `InPost lists more than ${MAX_SEARCH_PAGES * PAGE_SIZE} shipments since an hour before this Shipment was requested, so an earlier attempt cannot be ruled out and no new one was sent`,
  )
}
