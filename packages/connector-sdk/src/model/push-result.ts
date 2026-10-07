import { z } from 'zod'

/** A short Channel error code such as `OFFER_NOT_FOUND`: never free text, which may echo data. */
export const pushRejectionCodeSchema = z.string().trim().min(1).max(100)

const offerExternalId = z.string().min(1)

/**
 * The outcome of one Offer in a `stock.push` call. `ok`: applied. `ended`: applied, and the Channel ended the Offer
 * because its number is now 0 (only for a level of 0). `rejected`: the Channel refused this Offer permanently; the
 * other Offers of the call are unaffected.
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
