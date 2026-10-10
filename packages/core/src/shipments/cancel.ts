import type { ShipmentCancelResult } from '@hanza/connector-sdk'
import type { Tx } from '@hanza/db'
import { systemActor, type Actor } from '../actor'
import { afterCommit } from '../after-commit'
import type { Context } from '../context'
import { DomainError } from '../errors'
import { appendEvent } from '../events'
import { coalesceKeys, shipmentsTrackRef } from '../jobs/refs'
import { TX_OPTIONS } from '../transaction'
import { lockShipment, writeShipmentStatus } from './apply-state'
import { databaseNow } from './schedule'
import { isFinalStatus, isHandedOver } from './statuses'

type LockedShipment = NonNullable<Awaited<ReturnType<typeof lockShipment>>>

/**
 * Cancels, without asking anybody, a Shipment whose Carrier holds no answered request and is not being asked right
 * now. One statement, so it and a job taking the create lease cannot both win. Caller holds the lock of `lockShipment`.
 *
 * An earlier attempt may have reached the Carrier and lost its answer (`createAttempts` above 0). The SDK has no way
 * to look a Shipment up by `reference` without creating it, so the Event says an attempt was made and a person can
 * check the Carrier's own panel.
 */
async function cancelLocally(tx: Tx, organizationId: string, shipment: LockedShipment, actor: Actor): Promise<boolean> {
  const cancelled = await tx.$executeRaw`
    UPDATE "shipment"
    SET "status" = 'cancelled', "nextCheckAt" = NULL, "cancelRequestedAt" = NULL, "createLeaseUntil" = NULL, "updatedAt" = now()
    WHERE "id" = ${shipment.id} AND "organizationId" = ${organizationId}
      AND "status" = 'requested' AND "externalId" IS NULL
      AND ("createLeaseUntil" IS NULL OR "createLeaseUntil" <= now())`
  if (cancelled !== 1) return false
  await appendEvent(tx, {
    organizationId,
    type: 'shipment.status_changed',
    subject: { type: 'order', id: shipment.orderId },
    payload: {
      shipmentId: shipment.id,
      from: shipment.status,
      to: 'cancelled',
      carrierStatus: null,
      actor,
      ...(shipment.createAttempts > 0 ? { createAttempted: true } : {}),
    },
  })
  return true
}

/**
 * A person cancels a Shipment. One the Carrier was never successfully asked for, and is not being asked for right now,
 * is cancelled at once (`cancelled`). Any other is the Carrier's to cancel: the request is marked on the row and the
 * Connection's `shipments.track` job puts it to the Carrier (`requested`), which either cancels it or refuses, and a
 * refusal is kept as the Shipment's `failureCode` while its status goes on.
 *
 * Refused with `shipment_not_cancellable` once the Shipment is final or the Carrier has the parcel, and with
 * `shipment_cancel_unsupported` when the Carrier would have to be asked and its connector cannot.
 */
export async function cancelShipment(ctx: Context, organizationId: string, shipmentId: string, actor: Actor): Promise<{ outcome: 'cancelled' | 'requested' }> {
  const found = await ctx.db.shipment.findFirst({
    where: { id: shipmentId, organizationId },
    select: { connectionId: true, connection: { select: { connectorId: true } } },
  })
  if (!found) throw new DomainError('not_found')
  const canAsk = ctx.connectors.get(found.connection.connectorId)?.capabilities['shipments.cancel'] !== undefined

  const outcome = await ctx.db.$transaction(async (tx) => {
    const shipment = await lockShipment(tx, organizationId, shipmentId)
    if (!shipment) throw new DomainError('not_found')
    if (isFinalStatus(shipment.status) || isHandedOver(shipment.status)) throw new DomainError('shipment_not_cancellable')
    if (shipment.externalId === null && (await cancelLocally(tx, organizationId, shipment, actor))) return 'cancelled' as const
    if (!canAsk) throw new DomainError('shipment_cancel_unsupported')
    if (shipment.cancelRequestedAt !== null) return 'requested' as const

    // Due at once: the tick finds it even if the enqueue below is lost. An earlier refusal no longer describes it.
    await tx.$executeRaw`
      UPDATE "shipment" SET "cancelRequestedAt" = now(), "nextCheckAt" = now(), "failureCode" = NULL, "updatedAt" = now()
      WHERE "id" = ${shipment.id} AND "organizationId" = ${organizationId}`
    await appendEvent(tx, {
      organizationId,
      type: 'shipment.cancel_requested',
      subject: { type: 'order', id: shipment.orderId },
      payload: { shipmentId: shipment.id, actor },
    })
    return 'requested' as const
  }, TX_OPTIONS)

  if (outcome === 'requested') {
    // A Shipment whose create is still running has no Carrier id yet; the create job hands it on when it has one.
    const { connectionId } = found
    await afterCommit(ctx, { job: shipmentsTrackRef.name, organizationId, connectionId }, () =>
      ctx.queue.enqueue(shipmentsTrackRef, { organizationId, connectionId }, { coalesceKey: coalesceKeys.shipmentsTrack(connectionId) }),
    )
  }
  return { outcome }
}

/**
 * For the create job: a Shipment a person asked to cancel while its create was running, and that still has no answer
 * from the Carrier, is cancelled instead of being asked for again. False when it is not in that state, or another job
 * is asking right now.
 */
export async function cancelUnansweredShipment(ctx: Context, organizationId: string, shipmentId: string): Promise<boolean> {
  return ctx.db.$transaction(async (tx) => {
    const shipment = await lockShipment(tx, organizationId, shipmentId)
    if (!shipment || shipment.cancelRequestedAt === null || shipment.externalId !== null) return false
    return cancelLocally(tx, organizationId, shipment, systemActor)
  }, TX_OPTIONS)
}

/**
 * What the Carrier answered to a cancel. `cancelled` ends the Shipment. `refused` (too late) keeps its status and
 * stores the code, and the request is over either way, so it is not put to the Carrier again.
 */
export async function recordCancelResult(ctx: Context, organizationId: string, shipmentId: string, result: ShipmentCancelResult): Promise<void> {
  await ctx.db.$transaction(async (tx) => {
    const shipment = await lockShipment(tx, organizationId, shipmentId)
    if (!shipment || isFinalStatus(shipment.status)) return
    if (result.outcome === 'cancelled') {
      await writeShipmentStatus(tx, organizationId, shipment, { status: 'cancelled', now: await databaseNow(tx) })
      return
    }
    await tx.shipment.updateMany({ where: { id: shipment.id, organizationId }, data: { cancelRequestedAt: null, failureCode: result.code } })
    await appendEvent(tx, {
      organizationId,
      type: 'shipment.cancel_refused',
      subject: { type: 'order', id: shipment.orderId },
      payload: { shipmentId: shipment.id, code: result.code },
    })
  }, TX_OPTIONS)
}
