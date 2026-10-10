import { moneySchema, offerSchema, PermanentError } from '@hanza/connector-sdk'
import type { Money, Offer, OfferPublicationStatus } from '@hanza/connector-sdk'
import type { ListingOffer } from '../api/offers'
import { issuePaths } from '../api/common'

const PUBLICATION: Readonly<Record<string, OfferPublicationStatus>> = {
  ACTIVE: 'active',
  ACTIVATING: 'active',
  INACTIVE: 'inactive',
  ENDED: 'ended',
}

// Auctions have no fixed price; an unknown format is not assumed to have one either.
const PRICED_FORMATS: readonly string[] = ['BUY_NOW', 'ADVERTISEMENT']

/** `EMPTY_STOCK` is the only `endedBy` that means sold out; any other value, or none, is `other`. */
export function endedReasonOf(endedBy: string | null | undefined): 'sold_out' | 'other' {
  return endedBy === 'EMPTY_STOCK' ? 'sold_out' : 'other'
}

/**
 * The listing has no `endedBy`: an ended Offer with stock left cannot have sold out, so only one with no stock (or
 * none reported) needs `GET /sale/product-offers/{id}` to learn why it ended.
 */
export function needsEndedByLookup(offer: ListingOffer): boolean {
  if (offer.publication?.status !== 'ENDED') return false
  const available = offer.stock?.available
  return available === null || available === undefined || available === 0
}

function priceOf(offer: ListingOffer): Money | null {
  const format = offer.sellingMode?.format
  const price = offer.sellingMode?.price
  if (!format || !PRICED_FORMATS.includes(format) || !price) return null
  const money = { amount: price.amount, currency: price.currency.toUpperCase() }
  // Recorded only, never adopted (ADR 0011): a price that does not fit the canonical Money must not fail the page.
  return moneySchema.safeParse(money).success ? money : null
}

function offerUrl(siteBaseUrl: string, id: string): string {
  // The `/oferta/{id}` pattern is unverified against the API documentation.
  return `${siteBaseUrl.replace(/\/+$/, '')}/oferta/${encodeURIComponent(id)}`
}

/**
 * An Allegro Offer as a canonical Offer, or null for one Allegro fulfils itself (One Fulfillment), which Hanza does
 * not manage. `endedBy` is the result of the product-offer lookup for an ended Offer: `undefined` when not looked up.
 * An ended Offer that needed the lookup and did not get one has no `endedReason`, so Hanza never reopens it.
 */
export function mapOffer(offer: ListingOffer, options: { siteBaseUrl: string; endedBy?: string | null }): Offer | null {
  if (offer.isFulfillment === true) return null

  const statusText = offer.publication?.status
  const status = statusText ? PUBLICATION[statusText] : undefined
  let endedReason: 'sold_out' | 'other' | undefined
  if (status === 'ended') {
    if (options.endedBy !== undefined) endedReason = endedReasonOf(options.endedBy)
    else if (!needsEndedByLookup(offer)) endedReason = 'other'
  }

  const sku = offer.external?.id
  const candidate = {
    externalId: offer.id,
    sku: sku ? sku : null,
    name: offer.name,
    url: offerUrl(options.siteBaseUrl, offer.id),
    price: priceOf(offer),
    ...(status ? { status } : {}),
    ...(endedReason ? { endedReason } : {}),
  }
  const parsed = offerSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new PermanentError(`Allegro Offer ${offer.id} cannot be mapped to an Offer (${issuePaths(parsed.error)})`, {
      cause: parsed.error,
    })
  }
  return parsed.data
}
