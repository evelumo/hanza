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
import {
  CARRIER_TIMEOUT_CODE,
  confirmationTimedOut,
  databaseNow,
  nextShipmentCheck,
  SHIPMENT_CONFIRM_TIMEOUT_MS,
  SHIPMENT_FIRST_CHECK_MS,
} from './schedule'
import { isFinalStatus, isHandedOver, isUnconfirmed, statusStage, type ShipmentStatus } from './statuses'

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
  createOutcomeUnknown: true,
  labelContentType: true,
  labelFailureCode: true,
  createdAt: true,
  order: { select: { buyerDataErasedAt: true } },
} as const satisfies Prisma.ShipmentSelect

export type LockedShipment = Prisma.ShipmentGetPayload<{ select: typeof shipmentSelect }>

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

/**
 * Whether a Shipment in `status` is still owed a Label a person is waiting to print: it is confirmed, none is
 * stored, the fetch has not been given up on, and the Order's Buyer data, which a Label prints, is not erased.
 */
export function awaitsLabel(shipment: Pick<LockedShipment, 'labelContentType' | 'labelFailureCode' | 'order'>, status: ShipmentStatus): boolean {
  return status === 'ready' && shipment.labelContentType === null && shipment.labelFailureCode === null && shipment.order.buyerDataErasedAt === null
}

/**
 * A Shipment that still has no Carrier id although the Carrier was asked for it: one may exist there that Hanza does
 * not know of. Every attempt that left the row waiting ended without an answer being stored.
 */
export function mayExistAtCarrier(shipment: Pick<LockedShipment, 'externalId' | 'createAttempts' | 'createOutcomeUnknown'>): boolean {
  return shipment.externalId === null && (shipment.createOutcomeUnknown || shipment.createAttempts > 0)
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
  /** The Carrier answered the request for it (it made the Shipment, or refused it): nothing about it is unknown. */
  answered?: boolean
  data?: Prisma.ShipmentUpdateManyMutationInput
}

/**
 * Writes a Shipment's status with everything that follows from it, and the Event for what changed. A final status
 * owes the Shipment nothing more and deletes its Label, which nobody prints any more. A Shipment a person asked to
 * cancel is due at once, whatever its status says about when to look again, so the cancel goes out with the next run.
 * Caller holds the lock of `lockShipment`.
 *
 * The write that stores the Carrier's answer to the request (`answered`) leaves a Shipment that is not confirmed yet,
 * or has no Label, due within seconds instead of at its interval (`SHIPMENT_FIRST_CHECK_MS`): `firstCheck` in the
 * result says so, for the caller to enqueue the check that the tick would otherwise make a minute later.
 *
 * Events: `shipment.failed` or `shipment.status_changed` for a new status. A Shipment that stays unconfirmed while
 * its Carrier's own status changes to another one gets `shipment.carrier_status_changed`, because that status is
 * then the only thing that says what it waits for (funds on the account, say); a Carrier status that moves under a
 * later Shipment status is tracking detail and is only stored, so a poll never floods the timeline.
 */
export async function writeShipmentStatus(
  tx: Tx,
  organizationId: string,
  shipment: LockedShipment,
  write: StatusWrite,
): Promise<{ firstCheck: boolean }> {
  const { status, now } = write
  const final = isFinalStatus(status)
  const labelAwaited = awaitsLabel(shipment, status)
  const firstCheck = write.answered === true && (isUnconfirmed(status) || labelAwaited)
  const next = firstCheck
    ? new Date(now.getTime() + SHIPMENT_FIRST_CHECK_MS)
    : nextShipmentCheck(status, shipment.createdAt, now, { awaitsLabel: labelAwaited })
  const unknownOutcome = !write.answered && mayExistAtCarrier(shipment)
  await tx.shipment.updateMany({
    where: { id: shipment.id, organizationId },
    data: {
      ...write.data,
      status,
      ...(write.carrierStatus === undefined ? {} : { carrierStatus: write.carrierStatus }),
      nextCheckAt: next !== null && shipment.cancelRequestedAt !== null ? now : next,
      ...(status === 'failed' ? { failureCode: write.failureCode ?? null } : {}),
      ...(write.answered ? { createOutcomeUnknown: false } : {}),
      ...(final
        ? {
            label: null,
            labelContentType: null,
            labelFailureCode: null,
            cancelRequestedAt: null,
            createLeaseUntil: null,
            // Kept on the row it ends with, so the panel can still say that a parcel may exist at the Carrier.
            ...(write.answered ? {} : { createOutcomeUnknown: unknownOutcome }),
          }
        : {}),
    },
  })
  const subject = { type: 'order', id: shipment.orderId } as const
  if (status === shipment.status) {
    const reported = write.carrierStatus
    if (isUnconfirmed(status) && typeof reported === 'string' && reported !== shipment.carrierStatus) {
      await appendEvent(tx, {
        organizationId,
        type: 'shipment.carrier_status_changed',
        subject,
        payload: { shipmentId: shipment.id, status, from: shipment.carrierStatus, to: reported },
      })
    }
    return { firstCheck }
  }
  if (status === 'failed') {
    const payload = {
      shipmentId: shipment.id,
      from: shipment.status,
      code: write.failureCode ?? null,
      ...(unknownOutcome ? { createAttempted: true } : {}),
    }
    await appendEvent(tx, { organizationId, type: 'shipment.failed', subject, payload })
    return { firstCheck }
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
  return { firstCheck }
}

export type AppliedState =
  /** There is no such Shipment, it is final already, or the state is another Shipment's. */
  | { applied: false; reason: 'not_found' | 'final' | 'other_shipment' }
  | {
      applied: true
      status: ShipmentStatus
      pickup: PickupOutcome['outcome'] | null
      cancelRequested: boolean
      /** The Carrier's answer to the request was stored and the Shipment is due within seconds (`SHIPMENT_FIRST_CHECK_MS`). */
      firstCheck: boolean
    }

/**
 * Applies what a Carrier says about a Shipment, under its Order's lock: status, tracking number, the Carrier's own
 * status and the next check. `created` stores the answer to the request, giving the Shipment its `externalId`; a
 * tracked state is applied only to the Shipment that has that `externalId`. The first status that means the Carrier
 * has the parcel sets `handedOverAt` and ships the Order in the same transaction (ADR 0024). Idempotent: the same
 * state again changes nothing but the next check.
 *
 * A Shipment never goes back (`statusStage`): a final status is never left, one the Carrier had is never again
 * `ready` or `pending`, and a confirmed one is never again `pending`. A report of an earlier stage is a Carrier's
 * list lagging or a connector mistranslating, so it is logged and only the next check moves; `handedOverAt` and the
 * shipped Order are never undone. And only a Shipment that is unconfirmed both in the row and in the report fails
 * with `carrier_timeout` 24 hours after it was requested: a late `pending` cannot fail a Shipment the Carrier
 * confirmed.
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
    if (!shipment) return { applied: false as const, reason: 'not_found' as const }
    if (isFinalStatus(shipment.status)) return { applied: false as const, reason: 'final' as const }
    const answersRequest = mode === 'created' && shipment.externalId === null && shipment.status === 'requested'
    if (!answersRequest && shipment.externalId !== state.externalId) return { applied: false as const, reason: 'other_shipment' as const }

    const now = await databaseNow(tx)
    const cancelRequested = shipment.cancelRequestedAt !== null
    if (statusStage(state.status) < statusStage(shipment.status)) {
      ctx.log.info('shipment status not moved back', { organizationId, shipmentId, status: shipment.status, reported: state.status })
      await writeShipmentStatus(tx, organizationId, shipment, { status: shipment.status, now })
      return { applied: true as const, status: shipment.status, orderId: shipment.orderId, pickup: null, cancelRequested, firstCheck: false }
    }

    const timedOut = isUnconfirmed(shipment.status) && confirmationTimedOut(state.status, shipment.createdAt, now)
    const status: ShipmentStatus = timedOut ? 'failed' : state.status
    const handedOver = isHandedOver(status) && shipment.handedOverAt === null
    const { firstCheck } = await writeShipmentStatus(tx, organizationId, shipment, {
      status,
      now,
      // A Carrier that gives up on a Shipment says why in its own status.
      failureCode: timedOut ? CARRIER_TIMEOUT_CODE : state.carrierStatus,
      carrierStatus: state.carrierStatus,
      answered: answersRequest,
      data: {
        ...(answersRequest ? { externalId: state.externalId, createLeaseUntil: null } : {}),
        // A tracking number does not go away: an answer without one keeps the stored one.
        trackingNumber: state.trackingNumber ?? shipment.trackingNumber,
        ...(handedOver ? { handedOverAt: now } : {}),
      },
    })
    const pickup = handedOver ? await shipOrderOnPickup(ctx, tx, organizationId, shipment.orderId, shipment.id) : null
    return { applied: true as const, status, orderId: shipment.orderId, pickup, cancelRequested: cancelRequested && !isFinalStatus(status), firstCheck }
  }, TX_OPTIONS)

  if (!result.applied) return result
  if (result.pickup?.outcome === 'shipped') await requestPushesAfterStatusMove(ctx, organizationId, result.orderId, result.pickup.move)
  return {
    applied: true,
    status: result.status,
    pickup: result.pickup?.outcome ?? null,
    cancelRequested: result.cancelRequested,
    firstCheck: result.firstCheck,
  }
}

/**
 * A check in which the Carrier said nothing about the Shipment: its state is unchanged, so only the next check moves,
 * and one still unconfirmed after 24 hours fails with `carrier_timeout`.
 */
export async function keepShipmentState(ctx: Context, organizationId: string, shipmentId: string): Promise<AppliedState> {
  return ctx.db.$transaction(async (tx) => {
    const shipment = await lockShipment(tx, organizationId, shipmentId)
    if (!shipment) return { applied: false as const, reason: 'not_found' as const }
    if (isFinalStatus(shipment.status)) return { applied: false as const, reason: 'final' as const }
    const now = await databaseNow(tx)
    const timedOut = confirmationTimedOut(shipment.status, shipment.createdAt, now)
    const status: ShipmentStatus = timedOut ? 'failed' : shipment.status
    await writeShipmentStatus(tx, organizationId, shipment, { status, now, failureCode: CARRIER_TIMEOUT_CODE })
    return { applied: true as const, status, pickup: null, cancelRequested: shipment.cancelRequestedAt !== null && !timedOut, firstCheck: false }
  }, TX_OPTIONS)
}

/**
 * Fails a Shipment that is not final yet, for a reason of Hanza's own or a Carrier's refusal of the request: a short
 * code, never text. `answered` when the Carrier itself said so, which leaves nothing unknown about it. Returns false
 * when there was nothing to fail.
 */
export async function failShipment(
  ctx: Context,
  organizationId: string,
  shipmentId: string,
  code: string,
  options: { answered?: boolean } = {},
): Promise<boolean> {
  return ctx.db.$transaction(async (tx) => {
    const shipment = await lockShipment(tx, organizationId, shipmentId)
    if (!shipment || isFinalStatus(shipment.status)) return false
    await writeShipmentStatus(tx, organizationId, shipment, {
      status: 'failed',
      now: await databaseNow(tx),
      failureCode: code,
      answered: options.answered,
      data: options.answered ? { createLeaseUntil: null } : undefined,
    })
    return true
  }, TX_OPTIONS)
}

/**
 * Fails a Shipment the Carrier was never successfully asked for, 24 hours after it was requested, with
 * `carrier_timeout`. One statement, so it and a job taking the create lease cannot both win: while a lease is in
 * force (a job is asking, or the wait after a call whose outcome is not known has not passed) the timeout does not
 * fire, and the answer of a call in flight is never dropped for it. The Event says when a Shipment may exist at the
 * Carrier all the same (`createAttempted`). False when it is not in that state.
 */
export async function timeOutShipmentRequest(ctx: Context, organizationId: string, shipmentId: string): Promise<boolean> {
  return ctx.db.$transaction(async (tx) => {
    const shipment = await lockShipment(tx, organizationId, shipmentId)
    if (!shipment) return false
    const rows = await tx.$queryRaw<Array<{ createOutcomeUnknown: boolean }>>`
      UPDATE "shipment"
      SET "status" = 'failed', "failureCode" = ${CARRIER_TIMEOUT_CODE}, "nextCheckAt" = NULL, "cancelRequestedAt" = NULL,
        "createLeaseUntil" = NULL, "createOutcomeUnknown" = "createOutcomeUnknown" OR "createAttempts" > 0, "updatedAt" = now()
      WHERE "id" = ${shipment.id} AND "organizationId" = ${organizationId}
        AND "status" = 'requested' AND "externalId" IS NULL
        AND ("createLeaseUntil" IS NULL OR "createLeaseUntil" <= now())
        AND "createdAt" <= now() - ${SHIPMENT_CONFIRM_TIMEOUT_MS}::integer * interval '1 millisecond'
      RETURNING "createOutcomeUnknown"`
    const failed = rows[0]
    if (!failed) return false
    await appendEvent(tx, {
      organizationId,
      type: 'shipment.failed',
      subject: { type: 'order', id: shipment.orderId },
      payload: { shipmentId: shipment.id, from: 'requested', code: CARRIER_TIMEOUT_CODE, ...(failed.createOutcomeUnknown ? { createAttempted: true } : {}) },
    })
    return true
  }, TX_OPTIONS)
}
