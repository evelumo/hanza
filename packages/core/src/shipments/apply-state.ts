import type { ShipmentState } from '@hanza/connector-sdk'
import type { Prisma, Tx } from '@hanza/db'
import type { Actor } from '../actor'
import type { Context } from '../context'
import { appendEvent } from '../events'
import { ensureDefaultOrderStatuses } from '../order-statuses/defaults'
import { requestPushesAfterStatusMove } from '../orders/change-status'
import { shipOrderOnPickup, type PickupOutcome } from '../orders/ship-on-pickup'
import { lockOrder } from '../stock/locks'
import { ensureDefaultWarehouse } from '../stock/warehouse'
import { TX_OPTIONS } from '../transaction'
import { CARRIER_TIMEOUT_CODE, confirmationTimedOut, databaseNow, nextShipmentCheck } from './schedule'
import { isFinalStatus, isHandedOver, type ShipmentStatus } from './statuses'

const shipmentSelect = {
  id: true,
  orderId: true,
  status: true,
  externalId: true,
  trackingNumber: true,
  carrierStatus: true,
  failureCode: true,
  handedOverAt: true,
  cancelRequestedAt: true,
  createAttempts: true,
  createdAt: true,
} as const satisfies Prisma.ShipmentSelect

type LockedShipment = Prisma.ShipmentGetPayload<{ select: typeof shipmentSelect }>

/**
 * Takes the lock every change of a Shipment's status happens under: its Order's row, which is also the first lock of
 * ADR 0004, so a status that ships the Order can go on to the Stock locks. Returns the Shipment as it is under the
 * lock, or null when the organization has none with this id.
 */
export async function lockShipment(tx: Tx, organizationId: string, shipmentId: string): Promise<LockedShipment | null> {
  // The Order never changes, so this read needs no lock.
  const found = await tx.shipment.findFirst({ where: { id: shipmentId, organizationId }, select: { orderId: true } })
  if (!found || !(await lockOrder(tx, organizationId, found.orderId))) return null
  return tx.shipment.findFirst({ where: { id: shipmentId, organizationId }, select: shipmentSelect })
}

interface StatusWrite {
  status: ShipmentStatus
  now: Date
  /** Why it failed; only with status `failed`. */
  failureCode?: string | null
  /** The Carrier's own status, when a Carrier said it. */
  carrierStatus?: string | null
  /** Who cancelled it; the system for everything a Carrier reports. */
  actor?: Actor
  data?: Prisma.ShipmentUpdateManyMutationInput
}

/**
 * Writes a Shipment's status with everything that follows from it, and the Event for a status that changed. A final
 * status owes the Shipment nothing more and deletes its Label, which nobody prints any more. Caller holds the lock of
 * `lockShipment`.
 */
export async function writeShipmentStatus(tx: Tx, organizationId: string, shipment: LockedShipment, write: StatusWrite): Promise<void> {
  const { status, now } = write
  const final = isFinalStatus(status)
  await tx.shipment.updateMany({
    where: { id: shipment.id, organizationId },
    data: {
      ...write.data,
      status,
      ...(write.carrierStatus === undefined ? {} : { carrierStatus: write.carrierStatus }),
      nextCheckAt: nextShipmentCheck(status, shipment.createdAt, now),
      ...(status === 'failed' ? { failureCode: write.failureCode ?? null } : {}),
      ...(final ? { label: null, labelContentType: null, cancelRequestedAt: null, createLeaseUntil: null } : {}),
    },
  })
  if (status === shipment.status) return
  const subject = { type: 'order', id: shipment.orderId } as const
  if (status === 'failed') {
    const payload = { shipmentId: shipment.id, from: shipment.status, code: write.failureCode ?? null }
    await appendEvent(tx, { organizationId, type: 'shipment.failed', subject, payload })
    return
  }
  await appendEvent(tx, {
    organizationId,
    type: 'shipment.status_changed',
    subject,
    payload: {
      shipmentId: shipment.id,
      from: shipment.status,
      to: status,
      carrierStatus: write.carrierStatus === undefined ? shipment.carrierStatus : write.carrierStatus,
      ...(write.actor ? { actor: write.actor } : {}),
    },
  })
}

export type AppliedState =
  /** No such Shipment, it is final already, or the state is another Shipment's. */
  | { applied: false }
  | { applied: true; status: ShipmentStatus; pickup: PickupOutcome['outcome'] | null; cancelRequested: boolean }

/**
 * Applies what a Carrier says about a Shipment, under its Order's lock: status, tracking number, the Carrier's own
 * status and the next check. `created` stores the answer to the request, giving the Shipment its `externalId`; a
 * tracked state is applied only to the Shipment that has that `externalId`. A Shipment still unconfirmed 24 hours
 * after it was requested fails with `carrier_timeout` instead. The first status that means the Carrier has the parcel
 * sets `handedOverAt` and ships the Order in the same transaction (ADR 0024). Idempotent: the same state again
 * changes nothing but the next check, and a final status is never left.
 */
export async function applyShipmentState(
  ctx: Context,
  organizationId: string,
  shipmentId: string,
  state: ShipmentState,
  mode: 'created' | 'tracked',
): Promise<AppliedState> {
  if (isHandedOver(state.status)) {
    // Shipping the Order needs both; a first-time insert inside the transaction would hold its row locks until commit.
    await ensureDefaultWarehouse(ctx.db, organizationId)
    await ensureDefaultOrderStatuses(ctx.db, organizationId)
  }

  const result = await ctx.db.$transaction(async (tx) => {
    const shipment = await lockShipment(tx, organizationId, shipmentId)
    if (!shipment || isFinalStatus(shipment.status)) return { applied: false as const }
    const answersRequest = mode === 'created' && shipment.externalId === null && shipment.status === 'requested'
    if (!answersRequest && shipment.externalId !== state.externalId) return { applied: false as const }

    const now = await databaseNow(tx)
    const timedOut = confirmationTimedOut(state.status, shipment.createdAt, now)
    const status: ShipmentStatus = timedOut ? 'failed' : state.status
    const handedOver = isHandedOver(status) && shipment.handedOverAt === null
    await writeShipmentStatus(tx, organizationId, shipment, {
      status,
      now,
      // A Carrier that gives up on a Shipment says why in its own status.
      failureCode: timedOut ? CARRIER_TIMEOUT_CODE : state.carrierStatus,
      carrierStatus: state.carrierStatus,
      data: {
        ...(answersRequest ? { externalId: state.externalId, createLeaseUntil: null } : {}),
        // A tracking number does not go away: an answer without one keeps the stored one.
        trackingNumber: state.trackingNumber ?? shipment.trackingNumber,
        ...(handedOver ? { handedOverAt: now } : {}),
      },
    })
    const pickup = handedOver ? await shipOrderOnPickup(ctx, tx, organizationId, shipment.orderId, shipment.id) : null
    return {
      applied: true as const,
      status,
      orderId: shipment.orderId,
      pickup,
      cancelRequested: shipment.cancelRequestedAt !== null && !isFinalStatus(status),
    }
  }, TX_OPTIONS)

  if (!result.applied) return result
  if (result.pickup?.outcome === 'shipped') await requestPushesAfterStatusMove(ctx, organizationId, result.orderId, result.pickup.move)
  return { applied: true, status: result.status, pickup: result.pickup?.outcome ?? null, cancelRequested: result.cancelRequested }
}

/**
 * A check in which the Carrier said nothing about the Shipment: its state is unchanged, so only the next check moves,
 * and one still unconfirmed after 24 hours fails with `carrier_timeout`.
 */
export async function keepShipmentState(ctx: Context, organizationId: string, shipmentId: string): Promise<AppliedState> {
  return ctx.db.$transaction(async (tx) => {
    const shipment = await lockShipment(tx, organizationId, shipmentId)
    if (!shipment || isFinalStatus(shipment.status)) return { applied: false as const }
    const now = await databaseNow(tx)
    const timedOut = confirmationTimedOut(shipment.status, shipment.createdAt, now)
    const status: ShipmentStatus = timedOut ? 'failed' : shipment.status
    await writeShipmentStatus(tx, organizationId, shipment, { status, now, failureCode: CARRIER_TIMEOUT_CODE })
    return { applied: true as const, status, pickup: null, cancelRequested: shipment.cancelRequestedAt !== null && !timedOut }
  }, TX_OPTIONS)
}

/**
 * Fails a Shipment that is not final yet, for a reason of Hanza's own or a Carrier's refusal of the request: a short
 * code, never text. Returns false when there was nothing to fail.
 */
export async function failShipment(ctx: Context, organizationId: string, shipmentId: string, code: string): Promise<boolean> {
  return ctx.db.$transaction(async (tx) => {
    const shipment = await lockShipment(tx, organizationId, shipmentId)
    if (!shipment || isFinalStatus(shipment.status)) return false
    await writeShipmentStatus(tx, organizationId, shipment, { status: 'failed', now: await databaseNow(tx), failureCode: code })
    return true
  }, TX_OPTIONS)
}
