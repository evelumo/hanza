import { z } from 'zod'
import { moneySchema } from './money'
import { addressSchema } from './order'
import { pushRejectionCodeSchema } from './push-result'

/**
 * The Shipment statuses: the fixed list every connector translates its Carrier's own statuses into. Not an Order
 * phase or status.
 * - `pending`: the Carrier has the request and has not confirmed it.
 * - `ready`: confirmed; the Label can be printed; the Carrier does not have the parcel.
 * - `in_transit`: the Carrier has the parcel.
 * - `awaiting_pickup`: waiting for the Buyer in a locker or at a point.
 * - `delivery_problem`: the Carrier has the parcel and could not deliver it; it may try again or return it. Never
 *   for a Shipment the Carrier did not take: that one is `pending`, `ready`, `cancelled` or `failed`.
 * - `delivered`: the Buyer has it. Final.
 * - `returned`: back with the sender. Final.
 * - `cancelled`: cancelled or expired before the Carrier took it. Final.
 * - `failed`: the Carrier will never confirm it (no offer is left to buy). Final, so not for a payment that failed
 *   while the Carrier may still take another: that Shipment stays `pending`, with the reason as its carrier status.
 */
export const SHIPMENT_STATUSES = [
  'pending',
  'ready',
  'in_transit',
  'awaiting_pickup',
  'delivery_problem',
  'delivered',
  'returned',
  'cancelled',
  'failed',
] as const
export const shipmentStatusSchema = z.enum(SHIPMENT_STATUSES)
export type ShipmentStatus = z.infer<typeof shipmentStatusSchema>

/** The statuses a Shipment never leaves. */
export const FINAL_SHIPMENT_STATUSES: readonly ShipmentStatus[] = ['delivered', 'returned', 'cancelled', 'failed']

export function isFinalShipmentStatus(status: ShipmentStatus): boolean {
  return FINAL_SHIPMENT_STATUSES.includes(status)
}

/**
 * The statuses that mean the Carrier has, or had, the parcel. `ready` is not one: a printed Label is not a parcel
 * the Carrier took.
 */
export const HANDED_OVER_SHIPMENT_STATUSES: readonly ShipmentStatus[] = [
  'in_transit',
  'awaiting_pickup',
  'delivery_problem',
  'delivered',
  'returned',
]

export function isShipmentHandedOver(status: ShipmentStatus): boolean {
  return HANDED_OVER_SHIPMENT_STATUSES.includes(status)
}

/**
 * How long the core waits before it repeats a `shipments.create` whose outcome it does not know (the call threw, or
 * its answer could not be stored), counted from when that call started. Part of the contract: a Carrier without an
 * idempotency key can only make a create repeatable by looking the earlier Shipment up, and a Carrier's list may lag
 * behind its own create, so a repeat that came at once would find nothing and buy a second parcel.
 */
export const SHIPMENT_CREATE_RETRY_DELAY_MS = 300_000

/**
 * The shape of `ShipmentRequest.reference`: 1 to 64 letters, digits, `_` and `-`. The core sends the Shipment's id (a
 * UUID, 36 characters), so a connector may put it in a URL, a filter or a Carrier's reference field as it is.
 */
export const SHIPMENT_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** The shape of the Carrier's id of a Shipment: 1 to 100 letters, digits and `_ . : -`, like a short code. */
export const SHIPMENT_EXTERNAL_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/

/** The shape of a tracking number: as the Carrier's id, plus a space and `/`. */
export const SHIPMENT_TRACKING_NUMBER_PATTERN = /^[A-Za-z0-9_.:/ -]{1,100}$/

export const SHIPMENT_DESTINATION_TYPES = ['address', 'pickup_point'] as const
export const shipmentDestinationTypeSchema = z.enum(SHIPMENT_DESTINATION_TYPES)
export type ShipmentDestinationType = z.infer<typeof shipmentDestinationTypeSchema>

const named = z.object({ id: z.string().min(1), name: z.string().min(1) })

/**
 * One way a connector's Carrier takes a parcel, declared in `shipping.services`. The panel builds the form for a new
 * Shipment from it: an address or a pickup point, a parcel preset to choose (a locker size) or dimensions and weight
 * to type, and whether cash on delivery can be asked for.
 */
export const shippingServiceSchema = z.object({
  /** What `ShipmentRequest.service` carries; stored with every Shipment, so never rename it. */
  id: z.string().min(1),
  /** Shown to the person who picks the service; the Carrier's own product name. */
  name: z.string().min(1),
  destination: shipmentDestinationTypeSchema,
  parcel: z.discriminatedUnion('type', [
    z.object({ type: z.literal('presets'), presets: z.array(named).min(1) }),
    z.object({ type: z.literal('dimensions') }),
  ]),
  cashOnDelivery: z.boolean(),
})
export type ShippingService = z.infer<typeof shippingServiceSchema>

/** Who gets the parcel. Carriers need different parts of it (a phone for a locker, an e-mail for a notification). */
export const shipmentReceiverSchema = z.object({
  name: z.string().min(1),
  company: z.string().min(1).nullable(),
  email: z.string().min(1).nullable(),
  phone: z.string().min(1).nullable(),
})
export type ShipmentReceiver = z.infer<typeof shipmentReceiverSchema>

export const shipmentDestinationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('address'), address: addressSchema }),
  /** `pointId` is the Carrier's own code of the locker or point, as a person confirmed it. */
  z.object({ type: z.literal('pickup_point'), pointId: z.string().min(1) }),
])
export type ShipmentDestination = z.infer<typeof shipmentDestinationSchema>

const positiveInteger = z.number().int().positive()

/**
 * A preset the service declares (a locker size), or the parcel's own dimensions and weight. Strict on purpose: a
 * parcel that names a preset and also gives dimensions is neither.
 */
export const shipmentParcelSchema = z.union([
  z.object({ preset: z.string().min(1) }).strict(),
  z.object({ lengthMm: positiveInteger, widthMm: positiveInteger, heightMm: positiveInteger, weightGrams: positiveInteger }).strict(),
])
export type ShipmentParcel = z.infer<typeof shipmentParcelSchema>

/** What Hanza asks a Carrier for: one parcel of one Order. */
export const shipmentRequestSchema = z.object({
  /**
   * Hanza's Shipment id; the connector's key for a repeated create. At most 64 characters of letters, digits, `_` and
   * `-` (`SHIPMENT_REFERENCE_PATTERN`): safe in a URL, a query filter and a Carrier's own reference field.
   */
  reference: z.string().regex(SHIPMENT_REFERENCE_PATTERN),
  /** When Hanza first asked, the same on every repeat; bounds the connector's search for an earlier create. */
  requestedAt: z.iso.datetime({ offset: true }),
  /** The id of one of the connector's declared services. */
  service: z.string().min(1),
  receiver: shipmentReceiverSchema,
  destination: shipmentDestinationSchema,
  parcel: shipmentParcelSchema,
  /** The amount the Carrier collects from the Buyer; null for a parcel that is paid for. */
  cashOnDelivery: moneySchema.nullable(),
})
export type ShipmentRequest = z.infer<typeof shipmentRequestSchema>

export const SHIPMENT_REQUEST_PROBLEMS = ['destination_type', 'parcel_type', 'parcel_preset', 'cash_on_delivery'] as const
export type ShipmentRequestProblem = (typeof SHIPMENT_REQUEST_PROBLEMS)[number]

/**
 * Why a request does not fit the service it names, or null when it fits: the destination is of the other type, the
 * parcel is a preset where the service takes dimensions (or the reverse), the preset is not one the service declares,
 * or cash on delivery is asked of a service without it. The core refuses such a request before a connector sees it.
 */
export function shipmentRequestProblem(
  service: ShippingService,
  request: Pick<ShipmentRequest, 'destination' | 'parcel' | 'cashOnDelivery'>,
): ShipmentRequestProblem | null {
  if (request.destination.type !== service.destination) return 'destination_type'
  const { parcel } = request
  if ('preset' in parcel) {
    if (service.parcel.type !== 'presets') return 'parcel_type'
    if (!service.parcel.presets.some((preset) => preset.id === parcel.preset)) return 'parcel_preset'
  } else if (service.parcel.type !== 'dimensions') {
    return 'parcel_type'
  }
  if (request.cashOnDelivery !== null && !service.cashOnDelivery) return 'cash_on_delivery'
  return null
}

/** Where a Shipment is at its Carrier, as `shipments.create` and `shipments.track` report it. */
export const shipmentStateSchema = z.object({
  /**
   * The Carrier's id of the Shipment; what `track`, `label` and `cancel` are called with. A short id, never free text
   * (`SHIPMENT_EXTERNAL_ID_PATTERN`): it is stored in plaintext, indexed, and kept after the Buyer data is erased.
   */
  externalId: z.string().regex(SHIPMENT_EXTERNAL_ID_PATTERN),
  status: shipmentStatusSchema,
  /**
   * What the Buyer follows the parcel with; null until the Carrier gives one. Stored like the id, so the same rule
   * with a space and `/` allowed (`SHIPMENT_TRACKING_NUMBER_PATTERN`).
   */
  trackingNumber: z.string().regex(SHIPMENT_TRACKING_NUMBER_PATTERN).nullable(),
  /**
   * The Carrier's own status key, shown beside the Shipment status: a short code like a push rejection code (letters,
   * digits and `_ . : -`), never free text, which may echo an address.
   */
  carrierStatus: pushRejectionCodeSchema.nullable(),
})
export type ShipmentState = z.infer<typeof shipmentStateSchema>

/**
 * The outcome of `shipments.create`. `created`: the Carrier has the request; the Shipment's state follows.
 * `rejected`: the Carrier refuses this request for good, with a short code such as `target_point.does_not_exist`; the
 * Shipment fails and is never asked for again, so it is never the answer to a refusal of the whole account (no funds,
 * no contract at all), which is a thrown `PermanentError`.
 */
export const shipmentCreateResultSchema = z.discriminatedUnion('outcome', [
  shipmentStateSchema.extend({ outcome: z.literal('created') }),
  z.object({ outcome: z.literal('rejected'), code: pushRejectionCodeSchema }),
])
export type ShipmentCreateResult = z.infer<typeof shipmentCreateResultSchema>

/**
 * The outcome of `shipments.cancel`. `cancelled`: the Carrier confirmed the cancel, or itself reports the Shipment as
 * cancelled. `refused`: the Carrier does not cancel this Shipment, with a short code: `too_late`, or one saying the
 * Carrier does not know it.
 */
export const shipmentCancelResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('cancelled') }),
  z.object({ outcome: z.literal('refused'), code: pushRejectionCodeSchema }),
])
export type ShipmentCancelResult = z.infer<typeof shipmentCancelResultSchema>

/** A Label as `shipments.label` returns it: the file's media type (e.g. `application/pdf`) and its bytes, never empty. */
export const shipmentLabelSchema = z.object({
  contentType: z.string().min(1),
  // z.custom, not z.instanceof: the inferred type stays the plain Uint8Array, which a Node Buffer is assignable to.
  data: z.custom<Uint8Array>((value) => value instanceof Uint8Array && value.byteLength > 0, { error: 'expected a non-empty Uint8Array' }),
})
export type ShipmentLabel = z.infer<typeof shipmentLabelSchema>
