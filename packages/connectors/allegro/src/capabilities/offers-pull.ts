import { PermanentError, type Offer, type PullResult } from '@hanza/connector-sdk'
import { offersPageSchema, productOfferSchema, type ListingOffer } from '../api/offers'
import { concurrently, failureOf, parse, send, request, type AllegroContext } from '../client'
import { mapOffer, needsEndedByLookup } from '../mapping/offer'
import { environmentHosts } from '../settings'

/** Offers per `GET /sale/offers` page: the API's maximum. */
export const OFFERS_PAGE_SIZE = 1000
/** Drafts (`INACTIVE`) are left out; ended Offers stay in, so they stay linked. */
export const PULLED_PUBLICATION_STATUSES = ['ACTIVE', 'ACTIVATING', 'ENDED'] as const
/** `GET /sale/product-offers/{id}` lookups in flight at once. */
export const ENDED_BY_LOOKUP_CONCURRENCY = 3

const OFFSET = /^(0|[1-9]\d{0,8})$/

function offsetOf(cursor: string | null): number {
  if (cursor === null) return 0
  if (!OFFSET.test(cursor)) throw new PermanentError('Unreadable Allegro Offer cursor')
  return Number(cursor)
}

/**
 * Why an ended Offer ended: `publication.endedBy`, null when Allegro does not say, undefined when the Offer is gone
 * (then the mapping leaves `endedReason` out, so Hanza never reopens it).
 */
async function endedByOf(ctx: AllegroContext, offerId: string): Promise<string | null | undefined> {
  const response = await request(ctx, `/sale/product-offers/${encodeURIComponent(offerId)}`)
  if (response.status === 404) {
    await response.body?.cancel().catch(() => {})
    return undefined
  }
  if (!response.ok) throw await failureOf(response)
  const offer = await parse(response, productOfferSchema, 'Offer')
  return offer.publication?.endedBy ?? null
}

/** Every Offer of the seller but drafts and One Fulfillment ones, one offset page at a time; the cursor is the next offset. */
export async function pullOffers(ctx: AllegroContext, cursor: string | null): Promise<PullResult<Offer>> {
  const offset = offsetOf(cursor)
  const response = await send(ctx, '/sale/offers', {
    query: {
      limit: String(OFFERS_PAGE_SIZE),
      offset: String(offset),
      'publication.status': PULLED_PUBLICATION_STATUSES,
    },
  })
  const page = await parse(response, offersPageSchema, 'Offer list')
  const offers = page.offers.filter((offer) => offer.isFulfillment !== true)

  const lookups = offers.filter(needsEndedByLookup)
  const endedBy = new Map<string, string | null | undefined>(
    await concurrently(lookups, ENDED_BY_LOOKUP_CONCURRENCY, async (offer: ListingOffer) => [offer.id, await endedByOf(ctx, offer.id)] as const),
  )

  const siteBaseUrl = environmentHosts(ctx.app.environment).site
  const items: Offer[] = []
  for (const offer of offers) {
    const known = endedBy.get(offer.id)
    const mapped = mapOffer(offer, known === undefined ? { siteBaseUrl } : { siteBaseUrl, endedBy: known })
    if (mapped) items.push(mapped)
  }

  // `count > 0` too: a page that moved nothing must not ask for the same offset again.
  const next = offset + page.count
  return { items, nextCursor: String(next), hasMore: page.count > 0 && next < page.totalCount }
}
