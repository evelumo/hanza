import { z } from 'zod'

// Schemas of the answers the connector reads: the plugin's routes (wire format 1, AGENTS.md "Wire format with
// medusa-plugin-hanza") and the parts of Medusa's Admin API it uses. Lenient where Medusa leaves a field out or sends
// null; strict where a value decides what Hanza does (ids, statuses, times).

/** The wire format of `medusa-plugin-hanza` this connector speaks. */
export const WIRE_FORMAT = 1

const isoTime = z.iso.datetime({ offset: true })
/** A journal sequence number: an integer, also when a store's driver hands a bigint over as text. */
const seq = z.union([z.number().int().nonnegative(), z.string().regex(/^\d{1,15}$/).transform(Number)])
const optionalText = z.string().nullable().optional()

export const pluginSchema = z.object({ name: z.string(), version: z.string() })

export const hanzaSettingsSchema = z.object({
  stock_location_id: z.string().min(1).nullable(),
  sales_channel_ids: z.array(z.string().min(1)),
  pay_on_delivery_provider_ids: z.array(z.string().min(1)),
  paid_when: z.enum(['captured', 'authorized']),
  notify_customer_on_shipment: z.boolean(),
  journal_retention_days: z.number().int().positive().optional(),
  currency_code: z.string().min(1).nullable(),
})
export type HanzaSettings = z.output<typeof hanzaSettingsSchema>

export const hanzaStatusSchema = z.object({
  format: z.literal(WIRE_FORMAT),
  plugin: pluginSchema,
  store: z.object({ default_currency_code: z.string().min(1).nullable().optional() }),
  settings: hanzaSettingsSchema,
  journal: z.object({ oldest_seq: seq.nullable(), newest_seq: seq.nullable() }),
})
export type HanzaStatus = z.output<typeof hanzaStatusSchema>

/** Just enough of any answer of the plugin to tell which wire format it speaks. */
export const formatProbeSchema = z.object({
  format: z.unknown(),
  plugin: z.object({ version: z.unknown() }).partial().nullable().optional(),
})

export const journalEntrySchema = z.object({
  seq,
  type: z.string(),
  order_id: z.string().min(1),
  occurred_at: isoTime,
})
export type JournalEntry = z.output<typeof journalEntrySchema>

export const journalPageSchema = z.object({
  format: z.literal(WIRE_FORMAT),
  entries: z.array(journalEntrySchema),
  newest_seq: seq.nullable().optional(),
})

export const stockResultSchema = z.object({
  variant_id: z.string(),
  outcome: z.string(),
  code: z.string().nullable().optional(),
})
export const stockAnswerSchema = z.object({
  format: z.literal(WIRE_FORMAT),
  results: z.array(stockResultSchema),
})

/** A BigNumber's raw twin (`raw_total`, `raw_amount`): `{ value, precision }`, the value in major units. */
export const rawAmountSchema = z.object({ value: z.union([z.string(), z.number()]) }).loose().nullable().optional()
/** The JSON number twin of an amount; Medusa may also send it as text. */
const amount = z.union([z.number(), z.string()]).nullable().optional()

export const priceSchema = z.object({
  currency_code: z.string(),
  amount,
  raw_amount: rawAmountSchema,
  min_quantity: z.union([z.number(), z.string()]).nullable().optional(),
  max_quantity: z.union([z.number(), z.string()]).nullable().optional(),
  // How a price is tied to a region, a customer group or a price list: `rules` as Medusa's admin routes remap it
  // (`{ region_id: … }`), or the raw `price_rules` / `rules_count` of the pricing module.
  rules: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).nullable().optional(),
  rules_count: z.number().nullable().optional(),
  price_rules: z.array(z.unknown()).nullable().optional(),
  price_list_id: z.string().nullable().optional(),
})
export type MedusaPrice = z.output<typeof priceSchema>

export const variantSchema = z.object({
  id: z.string().min(1),
  sku: optionalText,
  title: optionalText,
  manage_inventory: z.boolean().nullable().optional(),
  product_id: optionalText,
  product: z.object({ title: optionalText, status: optionalText }).nullable().optional(),
  prices: z.array(priceSchema).nullable().optional(),
})
export type MedusaVariant = z.output<typeof variantSchema>

export const variantsPageSchema = z.object({
  variants: z.array(variantSchema),
  count: z.number().optional(),
})

/**
 * What `offers.pull` asks for: nothing it does not read. Medusa's admin route rebuilds each price's `rules` from
 * `price_rules`, which `*prices` alone does not load: without them a region's price would pass for a plain one.
 */
export const VARIANT_FIELDS = [
  'id',
  'sku',
  'title',
  'manage_inventory',
  'product_id',
  'product.title',
  'product.status',
  '*prices',
  'prices.price_rules.attribute',
  'prices.price_rules.value',
].join(',')

export const addressSchema = z.object({
  first_name: optionalText,
  last_name: optionalText,
  company: optionalText,
  address_1: optionalText,
  address_2: optionalText,
  city: optionalText,
  postal_code: optionalText,
  country_code: optionalText,
  province: optionalText,
  phone: optionalText,
})
export type MedusaAddress = z.output<typeof addressSchema>

export const lineItemSchema = z.object({
  id: z.string().min(1),
  title: optionalText,
  product_title: optionalText,
  variant_title: optionalText,
  variant_id: optionalText,
  variant_sku: optionalText,
  quantity: z.union([z.number(), z.string()]),
  raw_quantity: rawAmountSchema,
  total: amount,
  raw_total: rawAmountSchema,
})
export type MedusaLineItem = z.output<typeof lineItemSchema>

export const fulfillmentItemSchema = z.object({
  id: z.string().optional(),
  line_item_id: z.string().nullable().optional(),
  quantity: z.union([z.number(), z.string()]),
})

export const fulfillmentSchema = z.object({
  id: z.string().min(1),
  location_id: optionalText,
  shipped_at: isoTime.nullable().optional(),
  delivered_at: isoTime.nullable().optional(),
  canceled_at: isoTime.nullable().optional(),
  items: z.array(fulfillmentItemSchema).nullable().optional(),
})
export type MedusaFulfillment = z.output<typeof fulfillmentSchema>

export const paymentSchema = z.object({
  id: z.string().min(1),
  provider_id: z.string(),
  captured_at: isoTime.nullable().optional(),
  canceled_at: isoTime.nullable().optional(),
  captured_amount: amount,
})
export type MedusaPayment = z.output<typeof paymentSchema>

export const paymentCollectionSchema = z.object({
  id: z.string().optional(),
  payments: z.array(paymentSchema).nullable().optional(),
})

export const orderSchema = z.object({
  id: z.string().min(1),
  display_id: z.number().nullable().optional(),
  status: z.string(),
  created_at: isoTime,
  updated_at: isoTime,
  canceled_at: isoTime.nullable().optional(),
  email: optionalText,
  currency_code: z.string(),
  total: amount,
  raw_total: rawAmountSchema,
  sales_channel_id: optionalText,
  is_draft_order: z.boolean().nullable().optional(),
  payment_status: optionalText,
  fulfillment_status: optionalText,
  items: z.array(lineItemSchema).nullable().optional(),
  shipping_address: addressSchema.nullable().optional(),
  billing_address: addressSchema.nullable().optional(),
  fulfillments: z.array(fulfillmentSchema).nullable().optional(),
  payment_collections: z.array(paymentCollectionSchema).nullable().optional(),
  shipping_methods: z.array(z.object({ name: optionalText })).nullable().optional(),
  customer: z.object({ phone: optionalText }).nullable().optional(),
})
export type MedusaOrder = z.output<typeof orderSchema>

export const ordersPageSchema = z.object({
  orders: z.array(orderSchema),
  count: z.number().optional(),
})

/** The newest order, for the feed's boundary. */
export const boundaryPageSchema = z.object({
  orders: z.array(z.object({ id: z.string().min(1), created_at: isoTime })),
})

/**
 * What the Order feed asks for: the fields the mapper reads, and no more. `payment_status` and `fulfillment_status` are
 * not asked for: Medusa's order routes compute them on every answer (from the payment collections and fulfillments,
 * which it loads for that). Order totals are computed too and come as numbers only; `raw_total` is read where present.
 */
export const ORDER_FIELDS = [
  'id',
  'display_id',
  'status',
  'created_at',
  'updated_at',
  'canceled_at',
  'email',
  'currency_code',
  'total',
  'sales_channel_id',
  'is_draft_order',
  '*items',
  '*shipping_address',
  '*billing_address',
  '*fulfillments',
  '*payment_collections',
  '*payment_collections.payments',
  '*shipping_methods',
  'customer.phone',
].join(',')

/** What `orders.updateStatus` asks for: statuses, items, fulfillments with their items, payments. */
export const ORDER_STATE_FIELDS = [
  'id',
  'status',
  '*items',
  '*fulfillments',
  '*fulfillments.items',
  '*payment_collections',
  '*payment_collections.payments',
].join(',')

export const orderStateSchema = orderSchema.pick({ id: true, status: true, payment_status: true, fulfillment_status: true, items: true, fulfillments: true, payment_collections: true })
export type MedusaOrderState = z.output<typeof orderStateSchema>
export const singleOrderStateSchema = z.object({ order: orderStateSchema })
