import type { ShippingService } from '@hanza/connector-sdk'
import type { OrderDetail, ShipmentRow } from '@hanza/core'
import type { ShipmentStatus } from '@hanza/db'
import type { Tone } from '@/components/tone'
import { hasLabel } from './labels'

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

const FINAL: readonly ShipmentStatus[] = ['delivered', 'returned', 'cancelled', 'failed']
const UNCONFIRMED: readonly ShipmentStatus[] = ['requested', 'pending']

/** Whether "Check status" has something to ask: the Carrier knows the Shipment and may still say something new. */
export function canCheckShipment(shipment: Pick<ShipmentRow, 'status' | 'externalId'>): boolean {
  return shipment.externalId !== null && !FINAL.includes(shipment.status)
}

export type ShipmentNote =
  /** `reason`: a failure the catalogue explains (`labels.shipmentFailure`). `code`: the Carrier's own, shown as it is. */
  | { kind: 'failed'; reason: string | null; code: string | null }
  | { kind: 'cancelRequested' }
  | { kind: 'cancelRefused'; code: string }
  | { kind: 'arranging' }
  | { kind: 'labelPending' }
  | { kind: 'ready' }

/** What a person has to be told about a Shipment beyond its status; the one thing that matters most, or null. */
export function shipmentNote(shipment: Pick<ShipmentRow, 'status' | 'failureCode' | 'cancelRefusedCode' | 'cancelRequestedAt' | 'hasLabel'>): ShipmentNote | null {
  const { status } = shipment
  if (status === 'failed') {
    const known = shipment.failureCode !== null && hasLabel('labels.shipmentFailure', shipment.failureCode)
    return { kind: 'failed', reason: known ? shipment.failureCode : null, code: known ? null : shipment.failureCode }
  }
  if (FINAL.includes(status)) return null
  if (shipment.cancelRequestedAt !== null) return { kind: 'cancelRequested' }
  if (shipment.cancelRefusedCode !== null) return { kind: 'cancelRefused', code: shipment.cancelRefusedCode }
  if (UNCONFIRMED.includes(status)) return { kind: 'arranging' }
  if (status === 'ready') return { kind: shipment.hasLabel ? 'ready' : 'labelPending' }
  return null
}

/** How long after it was requested a Shipment is expected to change by itself within moments (the core checks it every tick until then). */
const SETTLING_MS = 600_000

/**
 * Whether the Shipment is about to change without anybody acting: the Carrier is being asked for it, for its Label,
 * or to cancel it. The page re-reads itself while one is, so the Label shows up without a reload.
 */
export function shipmentSettling(shipment: Pick<ShipmentRow, 'status' | 'cancelRequestedAt' | 'hasLabel' | 'createdAt'>, now: Date): boolean {
  if (FINAL.includes(shipment.status)) return false
  if (shipment.cancelRequestedAt !== null) return true
  const fresh = now.getTime() - shipment.createdAt.getTime() < SETTLING_MS
  return fresh && (UNCONFIRMED.includes(shipment.status) || (shipment.status === 'ready' && !shipment.hasLabel))
}

/** How long after a Carrier took a parcel the page allows for its Order to be read as still open. */
const PICKUP_SETTLING_MS = 60_000

/**
 * Whether the page may hold a torn read of a pickup: a Carrier has just taken a parcel, yet the Order was read as
 * open. The two change in one transaction (ADR 0024), but a page reads the Order and its Shipments in separate
 * queries, so a read that straddles the commit shows the new Shipment beside the old Order. The page re-reads itself
 * then. An Order that really could not be shipped stays open (and needs attention), so this ends after a minute.
 */
export function pickupSettling(order: Pick<OrderDetail, 'phase'>, shipments: Array<Pick<ShipmentRow, 'handedOverAt'>>, now: Date): boolean {
  if (order.phase !== 'new' && order.phase !== 'processing') return false
  // Either way round: the time is the database's, `now` the web server's.
  return shipments.some((shipment) => shipment.handedOverAt !== null && Math.abs(now.getTime() - shipment.handedOverAt.getTime()) < PICKUP_SETTLING_MS)
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
