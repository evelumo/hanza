import { z } from 'zod'
import { moneySchema } from './money'

/** Whether a Buyer can buy the Offer on its Channel now: `inactive` is a draft never published, `ended` is no longer for sale. */
export const OFFER_PUBLICATION_STATUSES = ['active', 'inactive', 'ended'] as const
export const offerPublicationStatusSchema = z.enum(OFFER_PUBLICATION_STATUSES)
export type OfferPublicationStatus = z.infer<typeof offerPublicationStatusSchema>

/** Why an `ended` Offer ended: `sold_out` when the Channel ended it because its stock reached 0, `other` for anything else (the seller, an admin, expiry). */
export const OFFER_ENDED_REASONS = ['sold_out', 'other'] as const
export const offerEndedReasonSchema = z.enum(OFFER_ENDED_REASONS)
export type OfferEndedReason = z.infer<typeof offerEndedReasonSchema>

export const offerSchema = z
  .object({
    externalId: z.string().min(1),
    sku: z.string().min(1).nullable(),
    name: z.string().min(1),
    url: z.url().nullable(),
    /**
     * The Offer's current price on the Channel, as the Channel reports it; null or omitted when unknown.
     * Hanza owns the price (ADR 0011): this only tells it the Channel's currency and is never adopted.
     */
    price: moneySchema.nullable().optional(),
    /** The Offer's publication on the Channel; omitted when the Channel does not say (unknown). Report ended Offers too: they stay linked. */
    status: offerPublicationStatusSchema.optional(),
    /** Only with `status: 'ended'`; omitted when the Channel does not say why, and then Hanza never reopens it (ADR 0022). */
    endedReason: offerEndedReasonSchema.optional(),
  })
  .refine((offer) => offer.endedReason === undefined || offer.status === 'ended', {
    message: 'endedReason is only allowed with status "ended"',
    path: ['endedReason'],
  })

export type Offer = z.infer<typeof offerSchema>
