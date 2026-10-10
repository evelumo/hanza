import { isFinalShipmentStatus, isShipmentHandedOver, type ShipmentStatus as CarrierShipmentStatus } from '@hanza/connector-sdk'
import type { ShipmentStatus } from '@hanza/db'

// A stored Shipment is in one of the SDK's Shipment statuses, or `requested`, which is Hanza's own: the Carrier has
// not been asked yet, or no answer was stored. A value added to one list only fails to compile here.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const sameStatuses: Same<ShipmentStatus, CarrierShipmentStatus | 'requested'> = true
void sameStatuses

export type { ShipmentStatus, CarrierShipmentStatus }

/** A Shipment never leaves these, and nothing more is asked of its Carrier. */
export function isFinalStatus(status: ShipmentStatus): boolean {
  return status !== 'requested' && isFinalShipmentStatus(status)
}

/** The Carrier has, or had, the parcel. */
export function isHandedOver(status: ShipmentStatus): boolean {
  return status !== 'requested' && isShipmentHandedOver(status)
}

/** The Carrier has not confirmed it: the statuses the 24 hour timeout applies to. */
export function isUnconfirmed(status: ShipmentStatus): boolean {
  return status === 'requested' || status === 'pending'
}

/**
 * How far a Shipment has got: 0 not confirmed, 1 confirmed (`ready`), 2 with the Carrier, 3 final. What a Carrier
 * reports never moves a Shipment to an earlier stage (see `applyShipmentState`); within a stage it moves freely.
 */
export function statusStage(status: ShipmentStatus): 0 | 1 | 2 | 3 {
  if (isUnconfirmed(status)) return 0
  if (isFinalStatus(status)) return 3
  return isHandedOver(status) ? 2 : 1
}
