import type { OfferPrice, PricePushResult } from '@hanza/connector-sdk'
import { concurrently, type AllegroContext } from '../client'
import { drain, editOffer, FORBIDDEN, OFFER_EDIT_CONCURRENCY, unlessAllForbidden } from './offer-edit'

type Outcome = { result: PricePushResult; forbidden: boolean }

async function pushOne(ctx: AllegroContext, { offerExternalId, price }: OfferPrice): Promise<Outcome> {
  // The amount goes as Hanza holds it: Allegro takes "24", "24.0" and "24.00" alike, and refuses more than two
  // decimals (422 `VALIDATION_ERROR`) or a price below its minimum (422 `PriceBelowMin`) for this Offer alone.
  const answer = await editOffer(ctx, offerExternalId, { sellingMode: { price: { amount: price.amount, currency: price.currency } } }, 'throw')
  if (!(answer instanceof Response)) return { result: answer, forbidden: answer.code === FORBIDDEN }
  // 200 echoes the Offer with the new price, 202 the Offer as it was: either way the edit is Allegro's to apply.
  await drain(answer)
  return { result: { offerExternalId, outcome: 'ok' }, forbidden: false }
}

/**
 * Buy-now prices, one `PATCH /sale/product-offers/{id}` with `sellingMode.price` per Offer, in the currency Hanza
 * sends (the one `offers.pull` reported; a currency the Offer's marketplace does not use is `rejected` with Allegro's
 * code, `IncorrectBaseCurrency`). A result for every price. A 403 refuses one Offer (another seller's); a 403 for
 * every Offer of the call is a missing scope, a `PermanentError`.
 */
export async function pushPrices(ctx: AllegroContext, prices: OfferPrice[]): Promise<PricePushResult[]> {
  if (prices.length === 0) return []
  return unlessAllForbidden(await concurrently(prices, OFFER_EDIT_CONCURRENCY, (price) => pushOne(ctx, price)))
}
