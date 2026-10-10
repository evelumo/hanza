import { PermanentError, type ShipmentRequest } from '@hanza/connector-sdk'
import type { ShipxShipment } from './api'
import { isLastPage, listShipments, PAGE_SIZE } from './client'
import type { InpostContext } from './config'

/** How far before `requestedAt` the search starts: room for a clock at InPost that runs behind Hanza's. */
const SEARCH_MARGIN_SECONDS = 5 * 60
/** 2000 shipments since the request. More means a busy day's backlog or a filter ShipX ignored: either way, stop. */
export const MAX_SEARCH_PAGES = 20

/**
 * The shipment an earlier `shipments.create` made for this request, or null when there is none.
 *
 * ShipX has no idempotency key and cannot filter by `reference`, and in simplified mode it buys the label within
 * seconds of the `POST`. So a create first lists what the organization made since shortly before Hanza first asked
 * (`requestedAt`, the same on every repeat) and compares references. Oldest first: shipments made meanwhile only
 * append, so a page never shifts under the search.
 *
 * The one place that knows how a repeat is found. If the sandbox shows that an organization that is not a broker
 * may set and filter by `external_customer_id`, use that exact filter here and set the field in the request body.
 */
export async function findEarlierShipment(ctx: InpostContext, request: Pick<ShipmentRequest, 'reference' | 'requestedAt'>): Promise<ShipxShipment | null> {
  // A Unix time, which ShipX documents next to ISO 8601: no offset to encode in a URL and none to misread.
  const since = Math.floor(Date.parse(request.requestedAt) / 1000) - SEARCH_MARGIN_SECONDS
  if (!Number.isFinite(since)) throw new PermanentError('The Shipment request has no readable requestedAt, so an earlier attempt cannot be looked for')
  const query = { created_at_gteq: String(since), sort_by: 'created_at', sort_order: 'asc' }
  for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
    const list = await listShipments(ctx, query, page)
    const earlier = list.items.find((shipment) => shipment.reference === request.reference)
    if (earlier) return earlier
    if (isLastPage(list)) return null
  }
  // Never post blindly: a second paid parcel is worse than a Shipment that waits for a person.
  throw new PermanentError(
    `InPost lists more than ${MAX_SEARCH_PAGES * PAGE_SIZE} shipments since this Shipment was requested, so an earlier attempt cannot be ruled out and no new one was sent`,
  )
}
