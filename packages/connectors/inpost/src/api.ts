import { z } from 'zod'

/** A ShipX shipment id as text: digits only. The one shape that may be put into a path or a query. */
export const SHIPMENT_ID = /^\d{1,20}$/

export function isShipmentId(value: string): boolean {
  return SHIPMENT_ID.test(value)
}

// ShipX answers ids as JSON numbers; the documentation shows them as strings of digits in a few examples. Anything
// else (`..`, a path, a word) is refused here, so an id InPost returned can never steer a later request elsewhere.
const id = z.union([z.number().int().nonnegative(), z.string().regex(SHIPMENT_ID)]).transform(String)

const offerSchema = z.object({
  status: z.string(),
  service: z.object({ id: z.string() }).nullish(),
  unavailability_reasons: z.array(z.object({ key: z.string() })).nullish(),
})

// `details` is the payment's own error (`{ status, error, message, details }`). Only its key is kept: the rest can
// name the account owner (an `owner_email` was seen on the sandbox, 2026-10-10).
const transactionSchema = z.object({
  status: z.string(),
  details: z
    .object({ error: z.string().nullish().catch(null) })
    .nullish()
    .catch(null),
})

/**
 * The parts of a ShipX shipment resource this connector reads. Everything else (sender, receiver, parcels) is
 * dropped on purpose: it is Buyer data the connector has no use for after the request.
 */
export const shipxShipmentSchema = z.object({
  id,
  status: z.string().min(1),
  tracking_number: z.string().nullable(),
  service: z.string().nullish(),
  reference: z.string().nullable(),
  // Read only while a purchase is pending. Tolerant, because statuses after `confirmed` cannot be recorded from
  // the sandbox: a resource that drops these lists once the parcel moves must not stop tracking.
  offers: z.array(offerSchema).nullish(),
  transactions: z.array(transactionSchema).nullish(),
})
export type ShipxShipment = z.output<typeof shipxShipmentSchema>

/**
 * A page of shipments. `page` and `per_page` are not read: ShipX echoes what was asked whatever it serves (with an
 * `id` filter the first page came back whole under `per_page: 3`, sandbox 2026-10-10), so only `count` and the items
 * themselves say how far a listing got.
 */
export const shipxShipmentListSchema = z.object({
  count: z.number().int().nonnegative(),
  items: z.array(shipxShipmentSchema),
})
export type ShipxShipmentList = z.output<typeof shipxShipmentListSchema>

/** `{ status, error, message | description, details }`: only the key and the details are read, never the message. */
export const shipxErrorSchema = z.object({
  error: z.string(),
  details: z.unknown().optional(),
})
