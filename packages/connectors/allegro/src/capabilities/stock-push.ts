import type { StockLevel, StockPushResult } from '@hanza/connector-sdk'
import { productOfferSchema, type ProductOffer } from '../api/offers'
import { concurrently, parse, readJson, type AllegroContext } from '../client'
import { drain, editOffer, FORBIDDEN, OFFER_EDIT_CONCURRENCY, rejected, unlessAllForbidden } from './offer-edit'

const REOPEN_PENDING = 'OFFER_REOPEN_PENDING'
// `endedBy` goes into a rejection code, so only a plain enum-like value does.
const ENDED_BY = /^[A-Za-z0-9_]{1,80}$/

type Outcome = { result: StockPushResult; forbidden: boolean }

/**
 * The Offer an accepted stock edit answers with. Allegro applies the publication side of an edit later (seen on the
 * sandbox: a 0 answers 200 still `ACTIVE`, the Offer is `ENDED` seconds after), and a 202 shows the Offer as it was
 * before the edit; when a 202's body does not parse there is nothing to tell from it (null).
 */
async function editedOffer(response: Response): Promise<ProductOffer | null> {
  if (response.status === 202) {
    const parsed = productOfferSchema.safeParse(await readJson(response, 'Offer edit'))
    return parsed.success ? parsed.data : null
  }
  return parse(response, productOfferSchema, 'Offer edit')
}

async function pushOne(ctx: AllegroContext, level: StockLevel): Promise<Outcome> {
  const { offerExternalId: offerId, available } = level
  const answer = await editOffer(ctx, offerId, { stock: { available } }, 'throw')
  if (!(answer instanceof Response)) return { result: answer, forbidden: answer.code === FORBIDDEN }
  const done = (result: StockPushResult): Outcome => ({ result, forbidden: false })
  const offer = await editedOffer(answer)
  const status = offer?.publication?.status
  // 0 leaves the Offer sold out: Allegro ends an active one, and an ended one stays ended. The answer cannot tell
  // (the ending happens after it), so only a draft (`INACTIVE`, which keeps 0 and stays a draft) is just set.
  if (available === 0) return done({ offerExternalId: offerId, outcome: status === 'INACTIVE' ? 'ok' : 'ended' })
  if (status !== 'ENDED') return done({ offerExternalId: offerId, outcome: 'ok' })

  // The number is set, but an ended Offer stays ended: reopen it only if it sold out (ADR 0022).
  const endedBy = offer?.publication?.endedBy
  if (endedBy !== 'EMPTY_STOCK') {
    return done(rejected(offerId, endedBy && ENDED_BY.test(endedBy) ? `OFFER_ENDED_${endedBy}` : 'OFFER_ENDED'))
  }
  // Accepted is done: Allegro answers the reopen 202 with the Offer as it was (still `ENDED`) and activates it seconds
  // later, so the body says nothing. A 409 (never seen on the sandbox, kept as a guard) would mean an earlier edit is
  // still being processed: the stock is set, the reopen waits for the next push.
  const reopened = await editOffer(ctx, offerId, { publication: { status: 'ACTIVE' } }, REOPEN_PENDING)
  if (!(reopened instanceof Response)) return done(reopened)
  await drain(reopened)
  return done({ offerExternalId: offerId, outcome: 'ok' })
}

/**
 * Absolute quantities, one `PATCH /sale/product-offers/{id}` per Offer (ADR 0022): 0 ends the Offer (`ended`; a
 * draft stays a draft, `ok`), a number above 0 sets it and reopens an Offer Allegro ended because it sold out, while
 * any other ended Offer is `rejected` with `OFFER_ENDED_<endedBy>`. A result for every level. A 403 refuses one Offer
 * (another seller's); a 403 for every Offer of the call is a missing scope, a `PermanentError`.
 */
export async function pushStock(ctx: AllegroContext, levels: StockLevel[]): Promise<StockPushResult[]> {
  if (levels.length === 0) return []
  return unlessAllForbidden(await concurrently(levels, OFFER_EDIT_CONCURRENCY, (level) => pushOne(ctx, level)))
}
