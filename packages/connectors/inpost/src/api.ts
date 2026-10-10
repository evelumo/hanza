import { z } from 'zod'

// The documentation shows ids as numbers in most examples and as strings in a few.
const id = z.union([z.number().int(), z.string().min(1)]).transform(String)

const offerSchema = z.object({
  status: z.string(),
  service: z.object({ id: z.string() }).nullish(),
  unavailability_reasons: z.array(z.object({ key: z.string() })).nullish(),
})

const transactionSchema = z.object({ status: z.string() })

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

export const shipxShipmentListSchema = z.object({
  count: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  per_page: z.number().int().positive(),
  items: z.array(shipxShipmentSchema),
})
export type ShipxShipmentList = z.output<typeof shipxShipmentListSchema>

/** `{ status, error, message | description, details }`: only the key and the details are read, never the message. */
export const shipxErrorSchema = z.object({
  error: z.string(),
  details: z.unknown().optional(),
})
