import { PermanentError, TransientError, type StockLevel, type StockPushResult } from '@hanza/connector-sdk'
import { productOfferSchema, type ProductOffer } from '../api/offers'
import { concurrently, errorCodeOf, failureOf, parse, readJson, request, type AllegroContext } from '../client'

/** `PATCH /sale/product-offers/{id}` requests in flight at once. */
export const STOCK_PUSH_CONCURRENCY = 3

const NOT_FOUND = 'OFFER_NOT_FOUND'
const FORBIDDEN = 'FORBIDDEN'
const REOPEN_PENDING = 'OFFER_REOPEN_PENDING'
const REJECTED = 'REJECTED'
// `endedBy` goes into a rejection code, so only a plain enum-like value does.
const ENDED_BY = /^[A-Za-z0-9_]{1,80}$/

type Edit = { stock: { available: number } } | { publication: { status: 'ACTIVE' } }
type Outcome = { result: StockPushResult; forbidden: boolean }

function offerPath(offerId: string): string {
  return `/sale/product-offers/${encodeURIComponent(offerId)}`
}

function rejected(offerExternalId: string, code: string): StockPushResult {
  return { offerExternalId, outcome: 'rejected', code }
}

async function drain(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {})
}

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

/**
 * One PATCH. Resolves with the accepted response, or with a rejection for this Offer alone (403, 404, 400, 422, and
 * a 409 when `onConflict` is a code); throws for anything that fails the whole push: a 409 on the stock edit (an
 * earlier edit still being processed: retrying the push is harmless), 401, 429, 5xx.
 */
async function edit(ctx: AllegroContext, offerId: string, body: Edit, onConflict: 'throw' | string): Promise<Response | StockPushResult> {
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

async function pushOne(ctx: AllegroContext, level: StockLevel): Promise<Outcome> {
  const { offerExternalId: offerId, available } = level
  const answer = await edit(ctx, offerId, { stock: { available } }, 'throw')
  if (!(answer instanceof Response)) return { result: answer, forbidden: answer.outcome === 'rejected' && answer.code === FORBIDDEN }
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
  const reopened = await edit(ctx, offerId, { publication: { status: 'ACTIVE' } }, REOPEN_PENDING)
  if (!(reopened instanceof Response)) return done(reopened)
  await drain(reopened)
  return done({ offerExternalId: offerId, outcome: 'ok' })
}

/**
 * Absolute quantities, one `PATCH /sale/product-offers/{id}` per Offer (ADR 0022): 0 ends the Offer (`ended`; a
 * draft stays a draft, `ok`), a number above 0 sets it and reopens an Offer Allegro ended because it sold out, while
 * any other ended Offer is `rejected` with `OFFER_ENDED_<endedBy>`. A result for every level. A 403 refuses one Offer (another seller's); a 403
 * for every Offer of the call is a missing scope, a `PermanentError`.
 */
export async function pushStock(ctx: AllegroContext, levels: StockLevel[]): Promise<StockPushResult[]> {
  if (levels.length === 0) return []
  const outcomes = await concurrently(levels, STOCK_PUSH_CONCURRENCY, (level) => pushOne(ctx, level))
  if (outcomes.every((outcome) => outcome.forbidden)) {
    throw new PermanentError('403 Forbidden for every Offer: check the scopes of the Allegro application')
  }
  return outcomes.map((outcome) => outcome.result)
}
