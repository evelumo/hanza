import { z } from 'zod'

// The parts of WooCommerce's `wc/v3` responses the connector reads, checked against WooCommerce 11.2.1.
// Only what is used: an unknown key never fails, and a missing or null text is the same as WooCommerce's `''`
// (plugins write nulls where the core writes empty strings).

const text = z
  .string()
  .nullish()
  .transform((value) => value ?? '')

const id = z.number().int().nonnegative()

/** `YYYY-MM-DDTHH:MM:SS`, no offset. The `_gmt` fields are UTC; their twins without the suffix are site time. */
export const wooDateTimeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)

// --- Orders ----------------------------------------------------------------------------------------------------------
//
// The shop is a server a member named, and half of an order is typed by a Buyer: nothing is read at any length. A
// value over its limit costs that one field and, at worst, that one order (it then "does not fit" and is skipped or
// reported by its facts), never the page: one Buyer's 100,000 characters must not stop a Connection's Order feed.
// Only what the feed itself runs on is strict: the id, the status and the two dates an order is listed by.

/** WooCommerce's largest `per_page`: no list of orders is longer. */
export const WOO_ORDERS_PER_PAGE_MAX = 100
/** More lines than any order placed by a person has. An order above it is read without lines, so it does not fit. */
export const WOO_LINE_ITEMS_MAX = 1000
/** A name, a street, a city: one line of text each. */
const ORDER_TEXT_MAX = 1000
/** A status, a gateway id, a SKU, a postcode, a phone number: WooCommerce keeps them in columns of 20 to 100 characters. */
const ORDER_WORD_MAX = 255
const STATUS_MAX = 64
/** WooCommerce stores amounts as decimal(26,8); a canonical amount has at most 20 characters. */
const AMOUNT_MAX = 40

/** A text cut at `max` characters; null or missing is `''`. For what a person reads. */
const orderText = (max: number) =>
  z
    .string()
    .nullish()
    .transform((value) => (value ?? '').slice(0, max))

/** A text of at most `max` characters; a longer one is read like a missing one, as `''`. For what is wrong when cut (a SKU, a gateway id). */
const orderWord = (max: number) =>
  z
    .string()
    .nullish()
    .transform((value) => (value != null && value.length <= max ? value : ''))

/** An amount as WooCommerce sends it, a string. One too long to be an amount is read as `''`, which no amount is: exact arithmetic on a megabyte of digits takes seconds. */
const amount = z.string().transform((value) => (value.length <= AMOUNT_MAX ? value : ''))

/** A list of at most `max` items; the length is checked before any item is read. */
const orderList = <T extends z.ZodType>(item: T, max: number) => z.array(z.unknown()).max(max).pipe(z.array(item))

function isDateTime(value: unknown): value is string {
  return typeof value === 'string' && wooDateTimeSchema.safeParse(value).success && !Number.isNaN(Date.parse(`${value}Z`))
}

/**
 * `date_paid_gmt` and `date_completed_gmt`: a date, or null for anything else. Old WooCommerce wrote
 * `-0001-11-30T00:00:00` for "never", and a plugin may write `''`: such a value means "not set", and reading it as
 * "set" would make every order of an old shop shipped. The status still says `completed` or `processing`, so a
 * payment or a shipment that shows in the status is never lost; what is lost is only the memory of one that the
 * status no longer shows (completed once, then reopened) on an order whose date cannot be read.
 */
const optionalDateTime = z
  .unknown()
  .optional()
  .transform((value) => (isDateTime(value) ? value : null))

export const wooAddressSchema = z.object({
  first_name: orderText(ORDER_TEXT_MAX),
  last_name: orderText(ORDER_TEXT_MAX),
  company: orderText(ORDER_TEXT_MAX),
  address_1: orderText(ORDER_TEXT_MAX),
  address_2: orderText(ORDER_TEXT_MAX),
  city: orderText(ORDER_TEXT_MAX),
  state: orderText(ORDER_WORD_MAX),
  postcode: orderText(ORDER_WORD_MAX),
  country: orderText(ORDER_WORD_MAX),
  phone: orderText(ORDER_WORD_MAX),
  /** Billing only. */
  email: orderText(ORDER_TEXT_MAX),
})
export type WooAddress = z.infer<typeof wooAddressSchema>

export const wooLineItemSchema = z.object({
  id: id.min(1),
  name: orderText(ORDER_TEXT_MAX),
  /** 0 once the product was deleted. */
  product_id: id.nullish().transform((value) => value ?? 0),
  /** 0 for a line that is not a variation. */
  variation_id: id.nullish().transform((value) => value ?? 0),
  /** An integer unless a plugin allows fractions. */
  quantity: z.number(),
  /** After discounts, without tax. */
  total: amount,
  total_tax: amount,
  /** `''` for a product without a SKU, null once the product was deleted; a variation without one reports its parent's. */
  sku: orderWord(ORDER_WORD_MAX),
})
export type WooLineItem = z.infer<typeof wooLineItemSchema>

export const wooOrderSchema = z.object({
  id: id.min(1),
  /** WooCommerce's own statuses, `trash`, `checkout-draft`, or one a plugin registered. */
  status: z.string().min(1).max(STATUS_MAX),
  currency: orderWord(ORDER_WORD_MAX),
  /** Strict, like `date_modified_gmt`: the feed is ordered by these two. */
  date_created_gmt: wooDateTimeSchema,
  date_modified_gmt: wooDateTimeSchema,
  /** Null until paid; stays set when the status moves on, also back to `on-hold`. */
  date_paid_gmt: optionalDateTime,
  /** Null until completed; stays set when the status moves away from `completed`. */
  date_completed_gmt: optionalDateTime,
  total: amount,
  /** A gateway id (`cod`, `bacs`, `stripe`, ...); `''` on an order nobody chose a method for. */
  payment_method: orderWord(ORDER_WORD_MAX),
  billing: wooAddressSchema,
  shipping: wooAddressSchema,
  line_items: z.preprocess((value) => (Array.isArray(value) && value.length > WOO_LINE_ITEMS_MAX ? [] : value), z.array(wooLineItemSchema)),
})
export type WooOrder = z.infer<typeof wooOrderSchema>

export const wooOrdersSchema = orderList(wooOrderSchema, WOO_ORDERS_PER_PAGE_MAX)

/** The fields of `wooOrderSchema`, for `_fields`: the shop then sends nothing else of an order (no note, no IP address, no meta). */
export const WOO_ORDER_FIELDS = Object.keys(wooOrderSchema.shape)

/** `GET orders?_fields=id`: only which orders there are. */
export const wooOrderIdsSchema = orderList(z.object({ id: id.min(1) }), WOO_ORDERS_PER_PAGE_MAX)

/** `GET` or `PUT orders/{id}?_fields=id,status`: the status of one order. */
export const wooOrderStatusSchema = z.object({ id: id.min(1), status: z.string().min(1).max(STATUS_MAX) })
export type WooOrderStatus = z.infer<typeof wooOrderStatusSchema>

// --- Products, variations, batches, the currency ---------------------------------------------------------------------
//
// The shop is a server a member named, so nothing it sends is taken at any length: every text read below has a limit.
// A value over its limit costs that one field (the Offer loses its SKU, its price or its link, or gets a shorter
// name), never the page: the other Offers of the page are fine, and the canonical Offer allows all of it.

/** WooCommerce's largest `per_page`, and the most items it takes in a batch: no list read here can be longer. */
export const WOO_MAX_PER_PAGE = 100
/** A product's title is a line of text; WordPress itself would store 65,535 bytes of it. */
export const WOO_NAME_MAX = 1000
/** WooCommerce looks SKUs up in a column of 100 characters. */
const SKU_MAX = 255
/** A canonical amount is at most 20 characters. */
const PRICE_MAX = 32
const URL_MAX = 2048
/** A type, a status, an error code: words WooCommerce or a plugin made up. */
const WORD_MAX = 64
/** A variation fixes a handful of attributes, each with a short value. */
const ATTRIBUTES_MAX = 20
const OPTION_MAX = 100

/** A text cut at `max` characters; null or missing is `''`. For what is shown or matched against a few known words. */
const clipped = (max: number) =>
  z
    .string()
    .nullish()
    .transform((value) => (value ?? '').slice(0, max))

/** A text of at most `max` characters; a longer one is read like a missing one, as `''`. For what is wrong when cut. */
const within = (max: number) =>
  z
    .string()
    .nullish()
    .transform((value) => (value != null && value.length <= max ? value : ''))

/** A word that must be there. */
const word = z
  .string()
  .min(1)
  .transform((value) => value.slice(0, WORD_MAX))

export const wooProductSchema = z.object({
  id: id.min(1),
  name: clipped(WOO_NAME_MAX),
  /** `simple`, `variable`, `grouped`, `external`, or a type a plugin added. */
  type: word,
  /** `publish`, `draft`, `pending`, `private`, ... */
  status: word,
  sku: within(SKU_MAX),
  /** The price a Buyer pays now (the sale price while on sale); `''` when none is set. No currency. */
  price: within(PRICE_MAX),
  permalink: within(URL_MAX),
})
export type WooProduct = z.infer<typeof wooProductSchema>

export const wooProductsSchema = z.array(wooProductSchema).max(WOO_MAX_PER_PAGE)

export const wooVariationSchema = z.object({
  id: id.min(1),
  /** `publish`, or `private` for a variation that is not enabled. */
  status: word,
  /** The parent's SKU when the variation has none of its own. */
  sku: within(SKU_MAX),
  price: within(PRICE_MAX),
  permalink: within(URL_MAX),
  /** One entry per attribute the variation fixes; an attribute left at "any" is not listed. */
  attributes: z
    .array(z.object({ name: clipped(OPTION_MAX), option: clipped(OPTION_MAX) }))
    .nullish()
    .transform((value) => (value ?? []).slice(0, ATTRIBUTES_MAX)),
})
export type WooVariation = z.infer<typeof wooVariationSchema>

export const wooVariationsSchema = z.array(wooVariationSchema).max(WOO_MAX_PER_PAGE)

/** `GET products?include=<ids>&_fields=id,type`: what each of some products is now. */
export const wooProductTypesSchema = z.array(z.object({ id: id.min(1), type: word })).max(WOO_MAX_PER_PAGE)
export const WOO_PRODUCT_TYPE_FIELDS: readonly string[] = ['id', 'type']

/**
 * `_fields` for the two lists: only what the schemas above read. A product comes with its descriptions, images and
 * every plugin's meta data, so a full page of 100 can weigh megabytes.
 */
export const WOO_PRODUCT_FIELDS: readonly string[] = Object.keys(wooProductSchema.shape)
export const WOO_VARIATION_FIELDS: readonly string[] = Object.keys(wooVariationSchema.shape)

/**
 * One entry of a batch answer: the whole product or variation after the update, or `{ id, error }` for an item
 * WooCommerce refused (the batch itself still answers 200).
 */
export const wooBatchItemSchema = z.object({
  id,
  /**
   * `code` is a short machine code such as `woocommerce_rest_product_invalid_id`. WordPress allows a number as an
   * error code, and one odd item must not fail the whole batch.
   */
  error: z.object({ code: z.union([z.string(), z.number()]).transform((code) => String(code).slice(0, WORD_MAX * 2)) }).optional(),
  /** `simple`, `variable`, ... on `products/batch`; `variation` on a variations batch. */
  type: z
    .string()
    .transform((value) => value.slice(0, WORD_MAX))
    .optional(),
  /** `publish`, `private`, ..., `trash`. */
  status: z
    .string()
    .transform((value) => value.slice(0, WORD_MAX))
    .optional(),
  /** `"parent"` on a variation that leaves its stock to the variable product; false whenever the shop does not manage stock. */
  manage_stock: z.union([z.boolean(), z.literal('parent')]).optional(),
  stock_quantity: z.number().nullable().optional(),
})
export type WooBatchItem = z.infer<typeof wooBatchItemSchema>

export const wooBatchResponseSchema = z.object({
  /** In the order of the request's `update`, and so never more than were sent. */
  update: z
    .array(wooBatchItemSchema)
    .max(WOO_MAX_PER_PAGE)
    .nullish()
    .transform((value) => value ?? []),
})
export type WooBatchResponse = z.infer<typeof wooBatchResponseSchema>

/** `GET data/currencies/current`: the shop's one currency. */
export const wooCurrencySchema = z.object({ code: z.string().transform((value) => value.slice(0, WORD_MAX)) })
export type WooCurrency = z.infer<typeof wooCurrencySchema>
