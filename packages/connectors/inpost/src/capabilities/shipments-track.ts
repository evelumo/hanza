import type { ShipmentState } from '@hanza/connector-sdk'
import { logUntranslated, shipmentsById } from '../client'
import type { InpostContext } from '../config'
import { toShipmentState } from '../mapping'

/**
 * Statuses come from the shipment resource, not from the public tracking endpoint, which returns nothing on the
 * sandbox. A shipment ShipX no longer lists, or whose status cannot be translated, is left out: it stays as it is.
 */
export async function trackShipments(ctx: InpostContext, externalIds: string[]): Promise<ShipmentState[]> {
  if (externalIds.length === 0) return []
  const states: ShipmentState[] = []
  for (const shipment of (await shipmentsById(ctx, externalIds)).values()) {
    const state = toShipmentState(shipment)
    if (state === null) logUntranslated(ctx, shipment)
    else states.push(state)
  }
  return states
}
