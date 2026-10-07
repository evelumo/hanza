import { z } from 'zod'

// The fake Channel's HTTP API, as its server sends it. Deliberately not the canonical shape, so the connector has mapping to do.

const money = z.object({ amount: z.string(), currency: z.string() })

export const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number(),
})

export const apiOfferSchema = z.object({
  id: z.string(),
  sku: z.string().nullable(),
  title: z.string(),
  price: money.nullable(),
})

export const offersPageSchema = z.object({
  offers: z.array(apiOfferSchema),
  cursor: z.string(),
  more: z.boolean(),
  links: z.object({ self: z.string() }),
})

const person = { firstName: z.string(), lastName: z.string() }

export const apiOrderSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  paymentType: z.enum(['ONLINE', 'CASH_ON_DELIVERY']),
  awaitingPayment: z.boolean(),
  total: money,
  buyer: z.object({
    ...person,
    email: z.string().nullable(),
    phone: z.string().nullable(),
    login: z.string().nullable(),
    // Sent by the Channel, never mapped (like Allegro's personalIdentity): the scrub config must remove it from fixtures.
    pesel: z.string().nullable(),
  }),
  delivery: z.object({
    ...person,
    company: z.string().nullable(),
    street: z.string(),
    zipCode: z.string(),
    city: z.string(),
    countryCode: z.string(),
    phone: z.string().nullable(),
  }),
  lines: z.array(
    z.object({ id: z.string(), offerId: z.string().nullable(), sku: z.string().nullable(), name: z.string(), quantity: z.number(), price: money }),
  ),
  events: z.array(z.object({ id: z.string(), type: z.enum(['CANCELLED', 'SENT', 'PAID']), at: z.string(), note: z.string().nullable() })),
})
export type ApiOrder = z.infer<typeof apiOrderSchema>

export const ordersPageSchema = z.object({
  orders: z.array(apiOrderSchema),
  cursor: z.string().nullable(),
  more: z.boolean(),
})

export const API_STATUSES = { new: 'NEW', processing: 'PROCESSING', shipped: 'SENT', cancelled: 'CANCELLED' } as const

export const stockRequestSchema = z.object({
  items: z.array(z.object({ offerId: z.string(), sku: z.string().nullable(), quantity: z.number().int().nonnegative() })),
})

export const statusRequestSchema = z.object({ status: z.enum(['NEW', 'PROCESSING', 'SENT', 'CANCELLED']) })
