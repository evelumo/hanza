import type { OrderPhase } from '@hanza/connector-sdk'
import type { FulfillmentStatus } from '../api/orders'

/** The Allegro fulfillment status `orders.updateStatus` sets for each Order phase (`PUT .../fulfillment`). */
export const FULFILLMENT_STATUS_FOR_PHASE = {
  new: 'NEW',
  processing: 'PROCESSING',
  shipped: 'SENT',
  cancelled: 'CANCELLED',
} as const satisfies Record<OrderPhase, FulfillmentStatus>

export function fulfillmentStatusFor(phase: OrderPhase): 'NEW' | 'PROCESSING' | 'SENT' | 'CANCELLED' {
  return FULFILLMENT_STATUS_FOR_PHASE[phase]
}
