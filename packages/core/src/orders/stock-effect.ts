import type { OrderStatus } from '@hanza/connector-sdk'
import type { Tx } from '@hanza/db'
import { consumeOrderReservations, releaseOrderReservations } from '../stock/reservations'

/** Stock effect of an Order becoming `to`: cancelled releases, shipped consumes. Returns the Products touched. */
export async function applyStockEffect(tx: Tx, organizationId: string, orderId: string, to: OrderStatus): Promise<string[]> {
  if (to === 'cancelled') return releaseOrderReservations(tx, organizationId, orderId)
  if (to === 'shipped') return consumeOrderReservations(tx, organizationId, orderId)
  return []
}
