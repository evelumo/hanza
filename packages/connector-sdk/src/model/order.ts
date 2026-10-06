import { z } from 'zod'
import { moneySchema } from './money'

/**
 * The Order phases (ADR 0018): the fixed list Hanza and every connector speak. Organizations label Orders with their own
 * Order statuses within these, which never reach a connector. Still named `OrderStatus` here (renaming it: issue #79).
 */
export const ORDER_STATUSES = ['new', 'processing', 'shipped', 'cancelled'] as const
export const orderStatusSchema = z.enum(ORDER_STATUSES)

export const CHANNEL_FACT_TYPES = ['cancelled', 'shipped', 'paid'] as const
export const channelFactTypeSchema = z.enum(CHANNEL_FACT_TYPES)

export const PAYMENT_METHODS = ['prepaid', 'cash_on_delivery'] as const
export const paymentMethodSchema = z.enum(PAYMENT_METHODS)

export const addressSchema = z.object({
  name: z.string().min(1),
  company: z.string().min(1).nullable(),
  /** Street, building and flat number in one line. */
  street: z.string().min(1),
  postalCode: z.string().min(1),
  city: z.string().min(1),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  phone: z.string().min(1).nullable(),
  /** Tax id for invoices (e.g. NIP); billing addresses only. */
  taxId: z.string().min(1).nullable(),
})

export const buyerSchema = z.object({
  name: z.string().min(1),
  /** Channels may mask or omit contact data. */
  email: z.string().min(1).nullable(),
  phone: z.string().min(1).nullable(),
  /** The Buyer's login on the Channel, if it has one. */
  login: z.string().min(1).nullable(),
})

/** Something the Channel reported after the Order was placed. `id` is stable per Order. */
export const channelFactSchema = z.object({
  id: z.string().min(1),
  type: channelFactTypeSchema,
  occurredAt: z.iso.datetime({ offset: true }),
  note: z.string().min(1).nullable(),
})

export const orderLineSchema = z.object({
  externalId: z.string().min(1),
  offerExternalId: z.string().min(1).nullable(),
  sku: z.string().min(1).nullable(),
  name: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPrice: moneySchema,
})

/**
 * An Order placed on the Channel. Ready to fulfil (paid, or cash on delivery) unless `awaitingPayment` is true.
 * A connector that does not report unpaid Orders leaves `awaitingPayment` out and returns only ready ones.
 */
export const orderSchema = z
  .object({
    externalId: z.string().min(1),
    placedAt: z.iso.datetime({ offset: true }),
    payment: paymentMethodSchema,
    /**
     * True while a prepaid Order waits for the Buyer's payment; omitted or false = ready to fulfil. Hanza reads it
     * only when it first imports the Order: when the payment arrives, add a `paid` fact and return the Order again.
     */
    awaitingPayment: z.boolean().optional(),
    total: moneySchema,
    buyer: buyerSchema,
    shippingAddress: addressSchema,
    billingAddress: addressSchema.nullable(),
    lines: z.array(orderLineSchema).min(1),
    /** Every Channel fact known so far, oldest first. */
    facts: z.array(channelFactSchema),
  })
  .superRefine((order, ctx) => {
    if (order.awaitingPayment !== true) return
    if (order.payment !== 'prepaid') {
      ctx.addIssue({ code: 'custom', path: ['awaitingPayment'], message: 'only a prepaid Order can be awaiting payment' })
    }
    if (order.facts.some((fact) => fact.type === 'paid')) {
      ctx.addIssue({ code: 'custom', path: ['awaitingPayment'], message: 'an Order with a paid fact is not awaiting payment' })
    }
  })

export type OrderStatus = z.infer<typeof orderStatusSchema>
export type ChannelFactType = z.infer<typeof channelFactTypeSchema>
export type PaymentMethod = z.infer<typeof paymentMethodSchema>
export type Address = z.infer<typeof addressSchema>
export type Buyer = z.infer<typeof buyerSchema>
export type ChannelFact = z.infer<typeof channelFactSchema>
export type OrderLine = z.infer<typeof orderLineSchema>
export type Order = z.infer<typeof orderSchema>
