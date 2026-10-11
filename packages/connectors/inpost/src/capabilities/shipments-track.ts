import type { ShipmentState } from '@hanza/connector-sdk'
import { isShipmentId } from '../api'
import { logUntranslated, shipmentsById } from '../client'
import type { InpostContext } from '../config'
import { toShipmentState } from '../mapping'

/**
 * Statuses come from the shipment resource, not from the public tracking endpoint, which returns nothing on the
 * sandbox. A shipment ShipX no longer lists, or whose status cannot be translated, is left out: it stays as it is.
 */
export async function trackShipments(ctx: InpostContext, externalIds: string[]): Promise<ShipmentState[]> {
  // An id that is not digits is not InPost's: ShipX answers the whole list with a 400 for one of them.
  const foreign = externalIds.filter((externalId) => !isShipmentId(externalId)).length
  if (foreign > 0) ctx.log('Shipments whose id is not an InPost shipment id were left out of tracking', { count: foreign })
  if (foreign === externalIds.length) return []
  const states: ShipmentState[] = []
  for (const shipment of (await shipmentsById(ctx, externalIds)).values()) {
    const state = toShipmentState(shipment)
    if (state === null) logUntranslated(ctx, shipment)
    else states.push(state)
  }
  return states
}
