import { z } from 'zod'

/**
 * A short Channel error code such as `OFFER_NOT_FOUND`: letters, digits and `_ . : -` only, never free text, which may
 * echo data (a Buyer's name, a token).
 */
export const pushRejectionCodeSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/)

const offerExternalId = z.string().min(1)

/**
 * The outcome of one Offer in a `stock.push` call. `ok`: applied. `ended`: applied, and the Offer is sold out (ended
 * because its number is 0) after the call; report it for every level of 0 that leaves the Offer sold out, also when it
 * already was, so a push retried after a lost answer still tells Hanza. Only for a level of 0. `rejected`: the Channel
 * refused this Offer permanently; the other Offers of the call are unaffected.
 */
export const stockPushResultSchema = z.discriminatedUnion('outcome', [
  z.object({ offerExternalId, outcome: z.literal('ok') }),
  z.object({ offerExternalId, outcome: z.literal('ended') }),
  z.object({ offerExternalId, outcome: z.literal('rejected'), code: pushRejectionCodeSchema }),
])
export type StockPushResult = z.infer<typeof stockPushResultSchema>

/** The outcome of one Offer in a `price.push` call: applied, or refused permanently (for example below the Channel's minimum price). */
export const pricePushResultSchema = z.discriminatedUnion('outcome', [
  z.object({ offerExternalId, outcome: z.literal('ok') }),
  z.object({ offerExternalId, outcome: z.literal('rejected'), code: pushRejectionCodeSchema }),
])
export type PricePushResult = z.infer<typeof pricePushResultSchema>
