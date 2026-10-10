import { PermanentError, TransientError, type Money } from '@hanza/connector-sdk'
import { errorCodeOf, failureOf, request, type AllegroContext } from '../client'

/** `PATCH /sale/product-offers/{id}` requests in flight at once, in one push. */
export const OFFER_EDIT_CONCURRENCY = 3

export const NOT_FOUND = 'OFFER_NOT_FOUND'
export const FORBIDDEN = 'FORBIDDEN'
const REJECTED = 'REJECTED'

/** The one Offer of a push that Allegro refused; fits both `StockPushResult` and `PricePushResult`. */
export interface Rejection {
  offerExternalId: string
  outcome: 'rejected'
  code: string
}

export type OfferEdit =
  | { stock: { available: number } }
  | { publication: { status: 'ACTIVE' } }
  | { sellingMode: { price: Money } }

function offerPath(offerId: string): string {
  return `/sale/product-offers/${encodeURIComponent(offerId)}`
}

export function rejected(offerExternalId: string, code: string): Rejection {
  return { offerExternalId, outcome: 'rejected', code }
}

export async function drain(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {})
}

/**
 * One PATCH. Resolves with the accepted response, or with a rejection for this Offer alone (403, 404, 400, 422, and
 * a 409 when `onConflict` is a code); throws for anything that fails the whole push: a 409 when `onConflict` is
 * `'throw'` (an earlier edit still being processed: retrying the push is harmless), 401, 429, 5xx.
 */
export async function editOffer(
  ctx: AllegroContext,
  offerId: string,
  body: OfferEdit,
  onConflict: 'throw' | string,
): Promise<Response | Rejection> {
  const response = await request(ctx, offerPath(offerId), { method: 'PATCH', json: body })
  if (response.ok) return response
  if (response.status === 403 || response.status === 404) {
    await drain(response)
    return rejected(offerId, response.status === 403 ? FORBIDDEN : NOT_FOUND)
  }
  if (response.status === 400 || response.status === 422) return rejected(offerId, (await errorCodeOf(response)) ?? REJECTED)
  if (response.status === 409) {
    await drain(response)
    if (onConflict !== 'throw') return rejected(offerId, onConflict)
    throw new TransientError('409 Conflict: an earlier edit of an Allegro Offer is still being processed')
  }
  throw await failureOf(response)
}

/**
 * The results of a push, unless every Offer of it answered 403: one Offer refused is another seller's, but all of them
 * refused is likelier a scope the application lacks, which no retry fixes.
 */
export function unlessAllForbidden<R>(outcomes: Array<{ result: R; forbidden: boolean }>): R[] {
  if (outcomes.length > 0 && outcomes.every((outcome) => outcome.forbidden)) {
    throw new PermanentError('403 Forbidden for every Offer: check the scopes of the Allegro application')
  }
  return outcomes.map((outcome) => outcome.result)
}
