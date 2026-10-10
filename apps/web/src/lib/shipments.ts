import type { ShippingService } from '@hanza/connector-sdk'
import type { OrderDetail, ShipmentLabelFailure, ShipmentRow } from '@hanza/core'
import type { ShipmentStatus } from '@hanza/db'
import type { Tone } from '@/components/tone'
import type { MessageKey } from '@/i18n/types'

/**
 * How a Shipment status reads. Everything on its way is `info`: a Shipment still being arranged with the Carrier is
 * as it should be, not a warning. Only what a person may have to act on stands out.
 */
export const shipmentStatusTone: Record<ShipmentStatus, Tone> = {
  requested: 'info',
  pending: 'info',
  ready: 'info',
  in_transit: 'info',
  awaiting_pickup: 'info',
  delivery_problem: 'warning',
  delivered: 'success',
  returned: 'neutral',
  cancelled: 'neutral',
  failed: 'critical',
}

// A code on a Shipment may be the Carrier's own: letters, digits and `_ . : -`, and a dot is a path to the message
// library. So a code is never made into a message key. The codes Hanza sets itself are listed here, each with its
// sentence, and anything else is shown as plain text.
const FAILURE_REASONS: Record<string, MessageKey> = {
  carrier_timeout: 'labels.shipmentFailure.carrier_timeout',
  buyer_data_erased: 'labels.shipmentFailure.buyer_data_erased',
  buyer_data_unreadable: 'labels.shipmentFailure.buyer_data_unreadable',
  request_invalid: 'labels.shipmentFailure.request_invalid',
  service_unavailable: 'labels.shipmentFailure.service_unavailable',
  duplicate_external_id: 'labels.shipmentFailure.duplicate_external_id',
}

/** The sentence for a failure code Hanza set itself; null for a Carrier's own code (and for none). */
export function shipmentFailureKey(code: string | null): MessageKey | null {
  return code !== null && Object.hasOwn(FAILURE_REASONS, code) ? FAILURE_REASONS[code]! : null
}

/** The code the core leaves when a person asked to cancel through a connector that no longer can. */
export const CANCEL_UNSUPPORTED_CODE = 'cancel_unsupported'

export const labelFailureKey: Record<ShipmentLabelFailure, MessageKey> = {
  too_large: 'labels.shipmentLabelFailure.too_large',
  invalid: 'labels.shipmentLabelFailure.invalid',
  refused: 'labels.shipmentLabelFailure.refused',
}

/** What the page knows about the Connection a Shipment went through; null when it is not one Shipments are made through any more. */
export interface ShipmentConnection {
  /** Failing, or waiting for a sign-in: nothing new reaches the Carrier until that is mended. */
  trouble: boolean
  /** Waiting for a sign-in, which is more than `trouble`: nothing asks the Carrier again until a person signs in. A failing Connection is tried again. */
  needsSignIn: boolean
  /** Whether a Shipment the Carrier has can be cancelled through Hanza. */
  canCancel: boolean
}

export type ShipmentNote =
  /** `reason`: the sentence for a failure Hanza explains. `code`: the Carrier's own, shown as it is. */
  | { kind: 'failed'; reason: MessageKey | null; code: string | null }
  /** The Carrier was asked and its answer never arrived: a Shipment (a bought label) may exist there. */
  | { kind: 'mayExistAtCarrier' }
  /** Still waiting to be asked for again after an attempt whose outcome is not known. */
  | { kind: 'retrying' }
  /** Nothing is sent to the Carrier while the Connection is as it is. */
  | { kind: 'connectionWaiting' }
  | { kind: 'arranging' }
  /** The Carrier has the request and has not confirmed it; `code` is its own status, the only thing that says why. */
  | { kind: 'unconfirmed'; code: string }
  | { kind: 'cancelRequested' }
  /** A cancel of a Shipment that never got its Carrier's answer: done here once nobody can be asking any more. */
  | { kind: 'cancelQueued' }
  | { kind: 'cancelRefused'; code: string }
  /** A cancel asked through a connector that cannot cancel (any more). */
  | { kind: 'cancelUnsupported' }
  | { kind: 'ready' }
  | { kind: 'labelPending' }
  | { kind: 'labelFailed'; reason: MessageKey }
  /** The Carrier has it, it can still be cancelled, but not through Hanza. */
  | { kind: 'cancelAtCarrier' }

type NoteFields = Pick<
  ShipmentRow,
  | 'status'
  | 'carrierStatus'
  | 'failureCode'
  | 'cancelRefusedCode'
  | 'cancelRequestedAt'
  | 'canCancel'
  | 'canCheck'
  | 'hasLabel'
  | 'labelFailureCode'
  | 'mayExistAtCarrier'
  | 'handedOverAt'
>

/**
 * What a person has to be told about a Shipment beyond its status, the most pressing first. Built only from what the
 * row says: nothing here guesses at what the worker is doing.
 */
export function shipmentNotes(shipment: NoteFields, connection: ShipmentConnection | null): ShipmentNote[] {
  const notes: ShipmentNote[] = []
  const { status } = shipment

  if (status === 'failed') {
    const reason = shipmentFailureKey(shipment.failureCode)
    notes.push({ kind: 'failed', reason, code: reason ? null : shipment.failureCode })
  }
  if (status === 'requested') {
    // A cancel that could not be done at once: the Carrier is not asked again, and the Shipment is cancelled here
    // when the wait after the last attempt is over. Otherwise: after an attempt nobody knows the outcome of, the row
    // waits out the retry delay, unless its Connection waits for a sign-in, which the scheduler skips, so no retry
    // comes (the label that may exist is still said); before any attempt it waits for its Connection, or for the
    // worker, which is a matter of moments.
    if (shipment.cancelRequestedAt !== null) notes.push({ kind: 'cancelQueued' })
    else if (shipment.mayExistAtCarrier && connection?.needsSignIn) notes.push({ kind: 'connectionWaiting' }, { kind: 'mayExistAtCarrier' })
    else if (shipment.mayExistAtCarrier) notes.push({ kind: 'retrying' })
    else notes.push({ kind: connection?.trouble ? 'connectionWaiting' : 'arranging' })
  } else if (shipment.mayExistAtCarrier) {
    // Cancelled here or timed out with the answer still unknown.
    notes.push({ kind: 'mayExistAtCarrier' })
  }
  if (status === 'pending') notes.push(shipment.carrierStatus ? { kind: 'unconfirmed', code: shipment.carrierStatus } : { kind: 'arranging' })

  if (shipment.cancelRequestedAt !== null && status !== 'requested') notes.push({ kind: 'cancelRequested' })
  else if (shipment.cancelRefusedCode === CANCEL_UNSUPPORTED_CODE) notes.push({ kind: 'cancelUnsupported' })
  else if (shipment.cancelRefusedCode !== null) notes.push({ kind: 'cancelRefused', code: shipment.cancelRefusedCode })

  if (status === 'ready') {
    if (shipment.hasLabel) notes.push({ kind: 'ready' })
    else if (shipment.labelFailureCode !== null) notes.push({ kind: 'labelFailed', reason: labelFailureKey[shipment.labelFailureCode] })
    else notes.push({ kind: 'labelPending' })
  }

  // The Carrier knows it and does not have the parcel yet, and the button that would cancel it is not there because
  // the connector has no such call: said once, where the button would be.
  const atCarrierUntaken = shipment.canCheck && shipment.handedOverAt === null
  if (atCarrierUntaken && !shipment.canCancel && connection?.canCancel === false && shipment.cancelRequestedAt === null && shipment.cancelRefusedCode === null) {
    notes.push({ kind: 'cancelAtCarrier' })
  }
  return notes
}

/** How long after a person's act the worker's answer to it is taken to be seconds away. */
const SETTLING_MS = 20_000

const recent = (at: Date | null, now: Date) => at !== null && Math.abs(now.getTime() - at.getTime()) < SETTLING_MS

/**
 * Whether the Shipment is about to change within seconds without anybody acting, so the page re-reads itself: it
 * was just created (the worker asks the Carrier at once and checks again a few seconds later, which is when the
 * Label comes), or a person just asked to cancel it. Only for that short window: a Shipment that waits for longer (a
 * Connection that is failing, a retry in five minutes, a Carrier that takes its time) is not polled; the person
 * reloads or presses "Check status".
 */
export function shipmentSettling(
  shipment: Pick<ShipmentRow, 'status' | 'cancelRequestedAt' | 'hasLabel' | 'labelFailureCode' | 'mayExistAtCarrier' | 'createdAt'>,
  now: Date,
): boolean {
  if (recent(shipment.cancelRequestedAt, now)) return true
  if (!recent(shipment.createdAt, now) || shipment.mayExistAtCarrier) return false
  if (shipment.status === 'requested' || shipment.status === 'pending') return true
  return shipment.status === 'ready' && !shipment.hasLabel && shipment.labelFailureCode === null
}

/**
 * Whether the page may hold a torn read of a pickup: a Carrier has just taken a parcel, yet the Order was read as
 * open. The two change in one transaction (ADR 0024), but a page reads the Order and its Shipments in separate
 * queries, so a read that straddles the commit shows the new Shipment beside the old Order. The page re-reads itself
 * then. An Order that really could not be shipped stays open (and needs attention), so this ends with the window.
 */
export function pickupSettling(order: Pick<OrderDetail, 'phase'>, shipments: Array<Pick<ShipmentRow, 'handedOverAt'>>, now: Date): boolean {
  if (order.phase !== 'new' && order.phase !== 'processing') return false
  // Either way round: the time is the database's, `now` the web server's.
  return shipments.some((shipment) => recent(shipment.handedOverAt, now))
}

export type ShipmentBlocker = 'shipped' | 'cancelled' | 'awaitingPayment' | 'buyerErased' | 'buyerUnreadable'

/** Why no Shipment can be created for the Order, in the order the core checks (`requestShipment`); null when one can. */
export function shipmentBlocker(order: Pick<OrderDetail, 'phase' | 'awaitingPayment' | 'buyerDataState'>): ShipmentBlocker | null {
  if (order.phase === 'shipped' || order.phase === 'cancelled') return order.phase
  if (order.awaitingPayment) return 'awaitingPayment'
  if (order.buyerDataState === 'erased') return 'buyerErased'
  if (order.buyerDataState === 'unreadable') return 'buyerUnreadable'
  return null
}

/** The service a new Shipment starts on: one that goes where the Buyer asked (a pickup point or an address), else the first. */
export function defaultServiceId(services: ShippingService[], toPickupPoint: boolean): string | undefined {
  const wanted = toPickupPoint ? 'pickup_point' : 'address'
  return (services.find((service) => service.destination === wanted) ?? services[0])?.id
}
