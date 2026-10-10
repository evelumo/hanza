import { z } from 'zod'
import { allegroDateTime, allegroEnum, allegroExternalIdSchema, allegroPriceSchema } from './common'

/**
 * `CheckoutFormStatus`: `BOUGHT` (no checkout form filled in yet), `FILLED_IN` (filled in, not paid; data may still
 * change), `READY_FOR_PROCESSING` (paid, or cash on delivery), `CANCELLED` (by the Buyer, or automatically by Allegro).
 */
export const CHECKOUT_FORM_STATUSES = ['BOUGHT', 'FILLED_IN', 'READY_FOR_PROCESSING', 'CANCELLED'] as const
export type CheckoutFormStatus = (typeof CHECKOUT_FORM_STATUSES)[number]

/** `CheckoutFormFulfillmentStatus`: the seller's status of the Order on Allegro. */
export const FULFILLMENT_STATUSES = [
  'NEW',
  'PROCESSING',
  'READY_FOR_SHIPMENT',
  'READY_FOR_PICKUP',
  'SENT',
  'PICKED_UP',
  'CANCELLED',
  'SUSPENDED',
  'RETURNED',
] as const
export type FulfillmentStatus = (typeof FULFILLMENT_STATUSES)[number]

/** `CheckoutFormPaymentType`. Only `CASH_ON_DELIVERY` is not prepaid. */
export const PAYMENT_TYPES = ['CASH_ON_DELIVERY', 'WIRE_TRANSFER', 'ONLINE', 'SPLIT_PAYMENT', 'EXTENDED_TERM'] as const
export type PaymentType = (typeof PAYMENT_TYPES)[number]

// Enums are parsed as strings (see `allegroEnum`); the lists above are what the mappers know.

/** `CheckoutFormDeliveryAddress`: where the parcel goes. Known only once the Buyer filled in the checkout form. */
export const checkoutFormAddressSchema = z.object({
  firstName: z.string().nullish(),
  lastName: z.string().nullish(),
  companyName: z.string().nullish(),
  street: z.string().nullish(),
  city: z.string().nullish(),
  zipCode: z.string().nullish(),
  countryCode: z.string().nullish(),
  phoneNumber: z.string().nullish(),
})
export type CheckoutFormAddress = z.infer<typeof checkoutFormAddressSchema>

/** `CheckoutFormBuyerAddressReference`: the Buyer's account address. Note `postCode`, not `zipCode`. */
export const checkoutFormBuyerAddressSchema = z.object({
  street: z.string().nullish(),
  city: z.string().nullish(),
  postCode: z.string().nullish(),
  countryCode: z.string().nullish(),
})
export type CheckoutFormBuyerAddress = z.infer<typeof checkoutFormBuyerAddressSchema>

// `personalIdentity` (PESEL) is left out on purpose: zod strips it, so it never reaches the mapping (ADR 0016).
const buyerSchema = z.object({
  id: z.string().nullish(),
  email: z.string().nullish(),
  login: z.string().nullish(),
  firstName: z.string().nullish(),
  lastName: z.string().nullish(),
  companyName: z.string().nullish(),
  guest: z.boolean().nullish(),
  phoneNumber: z.string().nullish(),
  address: checkoutFormBuyerAddressSchema.nullish(),
})

const invoiceAddressSchema = z.object({
  street: z.string().nullish(),
  city: z.string().nullish(),
  zipCode: z.string().nullish(),
  countryCode: z.string().nullish(),
  // Null means a private purchase.
  company: z
    .object({
      name: z.string().nullish(),
      ids: z.array(z.object({ type: allegroEnum, value: z.string() })).nullish(),
    })
    .nullish(),
  naturalPerson: z
    .object({
      firstName: z.string().nullish(),
      lastName: z.string().nullish(),
    })
    .nullish(),
})

/**
 * `CheckoutFormLineItem`. `price` is taken as the price of one unit after discounts (`originalPrice`: before them).
 * An assumption: swagger.yaml types both as a bare `Price` with no description, and nothing in it says per unit or
 * per line (its only "Unit price" is in an unrelated resource). To check against a real Order with quantity > 1:
 * `summary.totalToPay` should equal the sum of price x quantity plus delivery and surcharges.
 */
const lineItemSchema = z.object({
  id: z.string().min(1),
  offer: z.object({
    id: z.string().min(1),
    name: z.string(),
    external: allegroExternalIdSchema.nullish(),
  }),
  quantity: z.number(),
  price: allegroPriceSchema,
  originalPrice: allegroPriceSchema.nullish(),
  // Optional in the OpenAPI, always sent in practice; `placedAtOf` falls back to `updatedAt`.
  boughtAt: allegroDateTime.nullish(),
})

/**
 * `GET /order/checkout-forms/{id}` (`CheckoutForm`), only what the mapping needs. Not modelled, so stripped by zod
 * and never mapped: `messageToSeller` (Buyer text), `buyer.personalIdentity` (PESEL), surcharges, vouchers, the
 * delivery cost and the pickup point beyond its presence.
 */
export const checkoutFormSchema = z.object({
  id: z.string().min(1),
  status: allegroEnum,
  updatedAt: allegroDateTime.nullish(),
  revision: z.string().nullish(),
  buyer: buyerSchema,
  payment: z
    .object({
      type: allegroEnum.nullish(),
      finishedAt: allegroDateTime.nullish(),
      paidAmount: allegroPriceSchema.nullish(),
    })
    .nullish(),
  fulfillment: z
    .object({
      status: allegroEnum.nullish(),
      provider: z.object({ id: allegroEnum.nullish() }).nullish(),
    })
    .nullish(),
  delivery: z
    .object({
      address: checkoutFormAddressSchema.nullish(),
      method: z.object({ id: z.string().nullish(), name: z.string().nullish() }).nullish(),
      // Only whether there is one: its id and address are not mapped.
      pickupPoint: z.object({ id: z.string().nullish() }).nullish(),
    })
    .nullish(),
  invoice: z
    .object({
      required: z.boolean(),
      address: invoiceAddressSchema.nullish(),
    })
    .nullish(),
  lineItems: z.array(lineItemSchema),
  summary: z.object({
    totalToPay: allegroPriceSchema,
  }),
  marketplace: z.object({ id: z.string() }).nullish(),
})
export type CheckoutForm = z.infer<typeof checkoutFormSchema>
export type CheckoutFormLineItem = CheckoutForm['lineItems'][number]

/** `GET /order/checkout-forms` (`CheckoutForms`). */
export const checkoutFormsPageSchema = z.object({
  checkoutForms: z.array(checkoutFormSchema),
  count: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative(),
})
export type CheckoutFormsPage = z.infer<typeof checkoutFormsPageSchema>
