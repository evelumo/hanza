import { z } from 'zod'
import { allegroEnum, allegroExternalIdSchema, allegroPriceSchema } from './common'

/** `OfferStatus`: `INACTIVE` is a draft, `ACTIVATING` is planned or being published, `ENDED` is no longer for sale. */
export const OFFER_STATUSES = ['INACTIVE', 'ACTIVATING', 'ACTIVE', 'ENDED'] as const
export type OfferStatus = (typeof OFFER_STATUSES)[number]

/** `Publication.endedBy`: why an Offer ended. Only `EMPTY_STOCK` means sold out. */
export const ENDED_BY = ['USER', 'ADMIN', 'EXPIRATION', 'EMPTY_STOCK', 'PRODUCT_DETACHMENT', 'ERROR', 'VISIBILITY'] as const
export type EndedBy = (typeof ENDED_BY)[number]

/** `SellingModeFormat`. */
export const SELLING_MODE_FORMATS = ['BUY_NOW', 'AUCTION', 'ADVERTISEMENT'] as const
export type SellingModeFormat = (typeof SELLING_MODE_FORMATS)[number]

// Enums are parsed as strings (see `allegroEnum`); the lists above are what the mappers know.

/** One Offer of `GET /sale/offers` (`OfferListingDto`), only the fields the mapping needs. */
export const listingOfferSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  sellingMode: z
    .object({
      format: allegroEnum.nullish(),
      price: allegroPriceSchema.nullish(),
    })
    .nullish(),
  stock: z
    .object({
      available: z.number().int().nullish(),
    })
    .nullish(),
  publication: z
    .object({
      status: allegroEnum.nullish(),
    })
    .nullish(),
  external: allegroExternalIdSchema.nullish(),
  isFulfillment: z.boolean().nullish(),
})
export type ListingOffer = z.infer<typeof listingOfferSchema>

/** `GET /sale/offers` (`OffersSearchResultDto`). */
export const offersPageSchema = z.object({
  offers: z.array(listingOfferSchema),
  count: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative(),
})
export type OffersPage = z.infer<typeof offersPageSchema>

/**
 * `GET` / `PATCH /sale/product-offers/{offerId}` (`SaleProductOfferResponseV1`), only the publication and stock: the
 * listing has no `endedBy`, so this is where an ended Offer says whether it sold out.
 */
export const productOfferSchema = z.object({
  id: z.string().min(1),
  publication: z
    .object({
      status: allegroEnum.nullish(),
      endedBy: allegroEnum.nullish(),
    })
    .nullish(),
  stock: z
    .object({
      available: z.number().int().nullish(),
    })
    .nullish(),
})
export type ProductOffer = z.infer<typeof productOfferSchema>
