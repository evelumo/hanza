import { currencySchema, PermanentError, type Offer, type PullResult } from '@hanza/connector-sdk'
import { WOO_PRODUCT_FIELDS, WOO_VARIATION_FIELDS, wooCurrencySchema, wooProductsSchema, wooVariationsSchema, type WooProduct } from '../api'
import { request, requestIfAllowed, requestIfFound, type ApiResponse } from '../client'
import { mapProductOffer, mapVariationOffer, productKind } from '../mapping/offer'
import type { WooCommerceContext } from '../settings'

export interface OffersPullOptions {
  /** Products (and variations) asked for per request, 1 to 100. */
  pageSize: number
  /** Variation requests one call may make before it returns what it has; at least 1. Default `MAX_VARIATION_REQUESTS`. */
  maxVariationRequests?: number
}

/**
 * Variations are listed per variable product only (one list for all of them exists since WooCommerce 10.3, above the
 * oldest version supported), so a page of 100 variable products needs 100 requests or more. One call makes at most
 * this many of them and resumes in the middle of the page: a failed request then repeats a few requests, not a
 * hundred. Not lower, because the core reads a limited number of pages in a run.
 */
export const MAX_VARIATION_REQUESTS = 25

/** The variable product a call stopped in: the next page of its variations, and the last variation sent. */
export interface OffersParentPosition {
  id: number
  page: number
  after: number
}

/** Where a pull stands. Everything a call needs is in the cursor: the connector keeps nothing between calls. */
export interface OffersPosition {
  /** The shop's currency, read once when the pull starts; null when it could not be read. */
  currency: string | null
  /** The products page to read. */
  page: number
  /** The last product done with. Products up to it are skipped, so a page read again never sends an Offer twice. */
  after: number
  parent: OffersParentPosition | null
}

// `o1:<currency or ->:<products page>:<last product id>`, and `:<parent id>:<variations page>:<last variation id>`
// while a variable product is only partly read.
const CURSOR = /^o1:([A-Z]{3}|-):([1-9]\d*):(\d+)(?::([1-9]\d*):([1-9]\d*):(\d+))?$/

export function formatOffersCursor(position: OffersPosition): string {
  const base = `o1:${position.currency ?? '-'}:${position.page}:${position.after}`
  return position.parent === null ? base : `${base}:${position.parent.id}:${position.parent.page}:${position.parent.after}`
}

export function parseOffersCursor(cursor: string): OffersPosition {
  const match = CURSOR.exec(cursor)
  const numbers = (match ?? []).slice(2).map((value) => (value === undefined ? null : Number(value)))
  if (match === null || numbers.some((value) => value !== null && !Number.isSafeInteger(value))) {
    throw new PermanentError('offers.pull was given a cursor this connector did not make')
  }
  const [page, after, parentId, parentPage, parentAfter] = numbers as [number, number, number | null, number | null, number | null]
  return {
    currency: match[1] === '-' ? null : match[1]!,
    page,
    after,
    parent: parentId === null || parentPage === null || parentAfter === null ? null : { id: parentId, page: parentPage, after: parentAfter },
  }
}

/** The shop's one currency; null (and Offers without a price) when the key may not read it. */
async function shopCurrency(ctx: WooCommerceContext): Promise<string | null> {
  // Needs the right to manage WooCommerce, which a key made for the catalogue alone may lack: 403. The pull is worth
  // more than the prices, so it goes on without them.
  const response = await requestIfAllowed(ctx, { path: 'data/currencies/current', query: { _fields: ['code'] }, schema: wooCurrencySchema, what: 'currency' })
  if (response === null) {
    ctx.log('WooCommerce: the key may not read the shop currency, so Offers are pulled without prices')
    return null
  }
  if (currencySchema.safeParse(response.data.code).success) return response.data.code
  // A plugin's own currency (points, a token): not money Hanza can hold.
  ctx.log('WooCommerce: the shop currency is not an ISO 4217 code, so Offers are pulled without prices')
  return null
}

/**
 * The cursor skips by id, so both lists must come in the order asked for. A shop that answers in another one (a
 * plugin that reorders the catalogue) would lose Offers without a trace: fail instead.
 */
function assertById(items: ReadonlyArray<{ id: number }>, what: string): void {
  if (items.some((item, index) => index > 0 && item.id <= items[index - 1]!.id)) {
    throw new PermanentError(`The shop did not list its ${what} by id, so they cannot be paged`)
  }
}

/** `Link` and `X-WP-TotalPages` say whether a page follows; where a proxy dropped both, a full page may have one. */
function pageFollows(response: ApiResponse<unknown[]>, pageSize: number): boolean {
  return response.hasNextPage || (response.totalPages === null && response.data.length >= pageSize)
}

/**
 * `offers.pull`: every simple product and every variation of a variable product, by id.
 *
 * One call reads one page of products and, for the variable ones among them, pages of their variations, at most
 * `maxVariationRequests` of them: `maxVariationRequests` + 1 requests, and one more for the currency in the first
 * call. A page that needs more is read again by the next call, which goes on after the last product done with.
 *
 * The lists are paged by number, which WooCommerce offers nothing better than: a product deleted while a pull runs
 * moves the later ones up, and one of them can be missing until the next pull.
 */
export async function pullOffers(ctx: WooCommerceContext, cursor: string | null, options: OffersPullOptions): Promise<PullResult<Offer>> {
  const { pageSize } = options
  // With no variation request allowed, a call could stop where it started and return the cursor it was given.
  const budget = Math.max(1, options.maxVariationRequests ?? MAX_VARIATION_REQUESTS)
  const position = cursor === null ? { currency: await shopCurrency(ctx), page: 1, after: 0, parent: null } : parseOffersCursor(cursor)

  const products = await request(ctx, {
    path: 'products',
    query: { per_page: pageSize, page: position.page, orderby: 'id', order: 'asc', _fields: WOO_PRODUCT_FIELDS },
    schema: wooProductsSchema,
    what: 'products',
  })
  assertById(products.data, 'products')

  const items: Offer[] = []
  let after = position.after
  let variationRequests = 0
  for (const product of products.data) {
    if (product.id <= after) continue
    const kind = productKind(product)
    if (kind === 'simple') items.push(mapProductOffer(product, position.currency))
    if (kind === 'variable') {
      let at: OffersParentPosition = position.parent?.id === product.id ? position.parent : { id: product.id, page: 1, after: 0 }
      for (;;) {
        if (variationRequests === budget) {
          return { items, nextCursor: formatOffersCursor({ ...position, after, parent: at.page === 1 ? null : at }), hasMore: true }
        }
        variationRequests++
        const page = await pullVariations(ctx, product, at, position.currency, pageSize)
        items.push(...page.offers)
        if (page.next === null) break
        at = page.next
      }
    }
    after = product.id
  }

  if (!pageFollows(products, pageSize)) return { items, nextCursor: null, hasMore: false }
  return { items, nextCursor: formatOffersCursor({ currency: position.currency, page: position.page + 1, after, parent: null }), hasMore: true }
}

async function pullVariations(
  ctx: WooCommerceContext,
  parent: WooProduct,
  at: OffersParentPosition,
  currency: string | null,
  pageSize: number,
): Promise<{ offers: Offer[]; next: OffersParentPosition | null }> {
  const response = await requestIfFound(ctx, {
    path: `products/${parent.id}/variations`,
    query: { per_page: pageSize, page: at.page, orderby: 'id', order: 'asc', _fields: WOO_VARIATION_FIELDS },
    schema: wooVariationsSchema,
    what: 'variations',
  })
  // The product was deleted after its page was read (WooCommerce 11 answers an empty list; a 404 means the same).
  if (response === null) return { offers: [], next: null }
  assertById(response.data, 'variations')
  const fresh = response.data.filter((variation) => variation.id > at.after)
  return {
    offers: fresh.map((variation) => mapVariationOffer(parent, variation, currency)),
    next: pageFollows(response, pageSize) ? { id: parent.id, page: at.page + 1, after: fresh.at(-1)?.id ?? at.after } : null,
  }
}
