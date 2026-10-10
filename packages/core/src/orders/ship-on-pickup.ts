import type { Tx } from '@hanza/db'
import type { Context } from '../context'
import { appendEvent } from '../events'
import { moveOrderToStatus, type StatusMove } from './change-status'
import { addReasons } from './reasons'

export type PickupOutcome =
  /** The Order moved to phase shipped; `move` is what is left to do after commit (`requestPushesAfterStatusMove`). */
  | { outcome: 'shipped'; move: StatusMove }
  /** It was shipped before, by a person, the Channel or another Shipment: nothing changes. */
  | { outcome: 'already_shipped' }
  /** It cannot ship; it is marked Needs attention with `shipment_conflict`. */
  | { outcome: 'conflict' }

/**
 * A Carrier has a parcel of the Order, so the Order is shipped (ADR 0024): it moves to the default status of phase
 * shipped exactly as when a person chooses that phase, through the same `moveOrderToStatus`, so its Reservations are
 * consumed once, `closedAt` is set and the push to the Channel is marked pending. The first parcel ships the whole
 * Order; an Order already shipped is left as it is, whatever its status within that phase.
 *
 * An Order a person could not ship either (cancelled, awaiting payment, an Unmatched line) is not moved: the parcel is
 * on its way all the same, so the Order is marked Needs attention with `shipment_conflict` and a person settles it.
 *
 * Caller holds the Order lock, taken first in its transaction, and has made sure the organization's default Warehouse
 * and Order statuses exist.
 */
export async function shipOrderOnPickup(
  ctx: Pick<Context, 'connectors'>,
  tx: Tx,
  organizationId: string,
  orderId: string,
  shipmentId: string,
): Promise<PickupOutcome> {
  const order = await tx.order.findFirst({ where: { id: orderId, organizationId }, select: { phase: true, attentionReasons: true } })
  if (!order || order.phase === 'shipped') return { outcome: 'already_shipped' }

  const moved = await moveOrderToStatus(ctx, tx, organizationId, orderId, 'shipped', { cause: 'shipment', shipmentId })
  if (moved.moved) return { outcome: 'shipped', move: { stockPushConnectionIds: moved.stockPushConnectionIds, pushable: moved.pushable } }

  // The refused move wrote nothing, so the reasons read above still hold under the lock.
  const { reasons, added } = addReasons(order.attentionReasons, ['shipment_conflict'])
  if (added.length > 0) {
    const subject = { type: 'order', id: orderId } as const
    await tx.order.updateMany({ where: { id: orderId, organizationId }, data: { attentionReasons: reasons } })
    await appendEvent(tx, { organizationId, type: 'order.attention_raised', subject, payload: { reasons: added, shipmentId } })
  }
  return { outcome: 'conflict' }
}
