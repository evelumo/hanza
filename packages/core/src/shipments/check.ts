import { FINAL_SHIPMENT_STATUSES } from '@hanza/connector-sdk'
import { afterCommit } from '../after-commit'
import type { Context } from '../context'
import { DomainError } from '../errors'
import { coalesceKeys, shipmentsTrackRef } from '../jobs/refs'
import { isFinalStatus, type ShipmentStatus } from './statuses'

/**
 * Whether a Carrier can be asked where a Shipment is: it knows the Shipment (its answer to the request is stored), and
 * the Shipment is not final. The one rule behind `requestShipmentCheck` and `ShipmentRow.canCheck`.
 */
export function isCheckable(shipment: { status: ShipmentStatus; externalId: string | null }): boolean {
  return shipment.externalId !== null && !isFinalStatus(shipment.status)
}

/**
 * A person asks where a Shipment is now, instead of at its next scheduled check (15 minutes after the Carrier
 * confirmed it, an hour once the Carrier has the parcel). The Shipment becomes due at once and its Connection's
 * `shipments.track` job is enqueued; that job asks the Carrier, applies the answer and writes the next check, as for
 * any due Shipment. Nothing else changes here, so asking twice asks the Carrier once (the job is coalesced).
 *
 * Refused with `shipment_not_checkable` for a Shipment that is final, of which nothing more is asked, and for one the
 * Carrier does not know yet: its request is the `shipments.create` job's, and there is no id to ask about.
 */
export async function requestShipmentCheck(ctx: Context, organizationId: string, shipmentId: string): Promise<void> {
  const shipment = await ctx.db.shipment.findFirst({
    where: { id: shipmentId, organizationId },
    select: { connectionId: true, status: true, externalId: true },
  })
  if (!shipment) throw new DomainError('not_found')
  if (!isCheckable(shipment)) throw new DomainError('shipment_not_checkable')

  // The conditions again, in the statement: a Shipment that became final since the read above stays owed nothing.
  // No Order lock: only the due time moves, never later than it was, and the job writes the real one under the lock.
  await ctx.db.$executeRaw`
    UPDATE "shipment" SET "nextCheckAt" = LEAST(COALESCE("nextCheckAt", now()), now())
    WHERE "id" = ${shipmentId} AND "organizationId" = ${organizationId} AND "externalId" IS NOT NULL
      AND NOT ("status"::text = ANY(${[...FINAL_SHIPMENT_STATUSES]}::text[]))`

  // A failed enqueue is recovered by the sweep in `sync.tick`: the row is due.
  const { connectionId } = shipment
  await afterCommit(ctx, { job: shipmentsTrackRef.name, organizationId, connectionId }, () =>
    ctx.queue.enqueue(shipmentsTrackRef, { organizationId, connectionId }, { coalesceKey: coalesceKeys.shipmentsTrack(connectionId) }),
  )
}
