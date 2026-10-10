import { findShippingService, shipmentRequestProblem, type ShipmentState } from '@hanza/connector-sdk'
import { afterCommit } from '../after-commit'
import { finishSyncRun } from '../connections/sync-state'
import type { Context } from '../context'
import { describeFailure } from '../describe-failure'
import { isUniqueViolation } from '../errors'
import { defineJob } from '../jobs'
import { storedBuyerDataSelect } from '../privacy/buyer-data'
import { applyShipmentState, failShipment } from '../shipments/apply-state'
import { buildShipmentRequest } from '../shipments/build-request'
import { cancelUnansweredShipment } from '../shipments/cancel'
import { parseCreateResult } from '../shipments/carrier-answers'
import { claimShipmentCreate, releaseShipmentCreate } from '../shipments/claims'
import { CARRIER_TIMEOUT_CODE, confirmationTimedOut, databaseNow } from '../shipments/schedule'
import { withSyncRun } from '../sync/begin-run'
import { runConnectorCall } from '../sync/run-connector'
import { coalesceKeys, shipmentsCreateRef, shipmentsTrackRef } from './refs'

/**
 * Stores the Shipment the Carrier answered with; true when a cancel is waiting for it. An answer naming a Shipment
 * another row already holds means the connector did not key the request by its `reference`: asking again would only
 * repeat it, so the Shipment fails.
 */
async function storeCreated(
  ctx: Context,
  ids: { organizationId: string; connectionId: string; shipmentId: string },
  state: ShipmentState,
): Promise<boolean> {
  const { organizationId, shipmentId } = ids
  try {
    const applied = await applyShipmentState(ctx, organizationId, shipmentId, state, 'created')
    return applied.applied && applied.cancelRequested
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    ctx.log.error('shipment create answered with the id of another Shipment', ids)
    await failShipment(ctx, organizationId, shipmentId, 'duplicate_external_id')
    return false
  }
}

/**
 * Asks the Carrier for a Shipment that is still `requested` and stores its answer (ADR 0023). It never calls the
 * connector for a Shipment that has an `externalId` or left `requested`, so a duplicate or late job does nothing.
 *
 * The crash this is built around: the Carrier made the Shipment and the answer never reached the row (the worker
 * died, the response timed out, the write failed). The row then still says `requested` and stays due, so the queue's
 * retry or the tick's sweep runs this job again, and the connector, which must return the Shipment an earlier call
 * with the same `reference` made, gives that one back. The lease keeps two runs from asking at the same moment, the
 * one case that lookup cannot cover.
 *
 * A failure of the call goes the way of every connector call (`runConnectorCall`): the Connection's health and the
 * `shipments_create` stream record it and the Shipment keeps waiting. Only the Carrier refusing the request, the
 * Buyer data being gone, or 24 hours without an answer fail the Shipment itself.
 */
export const shipmentsCreateJob = defineJob({
  ...shipmentsCreateRef,
  async handler(ctx, payload, run) {
    const { organizationId, shipmentId } = payload
    const shipment = await ctx.db.shipment.findFirst({
      where: { id: shipmentId, organizationId },
      select: {
        id: true,
        organizationId: true,
        connectionId: true,
        status: true,
        externalId: true,
        service: true,
        parcel: true,
        codAmount: true,
        codCurrency: true,
        destination: true,
        cancelRequestedAt: true,
        createdAt: true,
        order: { select: storedBuyerDataSelect },
      },
    })
    if (!shipment) {
      ctx.log.info('shipment create skipped: no such Shipment', { organizationId, shipmentId })
      return
    }
    if (shipment.status !== 'requested' || shipment.externalId !== null) return
    if (shipment.cancelRequestedAt !== null) {
      // Asked to be cancelled while an earlier run was asking the Carrier. If that run is still at it, it hands the
      // Shipment on with the Carrier's id; if it failed, there is nothing at the Carrier that Hanza knows of.
      await cancelUnansweredShipment(ctx, organizationId, shipmentId)
      return
    }
    if (confirmationTimedOut(shipment.status, shipment.createdAt, await databaseNow(ctx.db))) {
      await failShipment(ctx, organizationId, shipmentId, CARRIER_TIMEOUT_CODE)
      return
    }
    const built = buildShipmentRequest(ctx.secrets, shipment)
    if ('failure' in built) {
      await failShipment(ctx, organizationId, shipmentId, built.failure)
      return
    }
    const { request } = built
    const { connectionId } = shipment

    const input = { organizationId, connectionId, stream: 'shipments_create', capability: 'shipments.create', run } as const
    await withSyncRun(ctx, input, async ({ connector, context, scope }) => {
      const untouched = () => finishSyncRun(ctx, organizationId, connectionId, 'shipments_create', {}, { calledChannel: false })
      // The connector may have changed since the person asked: it is still only sent what fits a service it declares.
      const service = findShippingService(connector, request.service)
      if (!service || shipmentRequestProblem(service, request) !== null) {
        await failShipment(ctx, organizationId, shipmentId, 'service_unavailable')
        return untouched()
      }
      const lease = await claimShipmentCreate(ctx, organizationId, shipmentId)
      if (lease === null) return untouched()

      let cancelRequested = false
      let outcome: 'created' | 'rejected'
      try {
        const result = await runConnectorCall(ctx, scope, async () => parseCreateResult(await connector.capabilities['shipments.create']!(context, request)))
        outcome = result.outcome
        if (result.outcome === 'rejected') {
          await failShipment(ctx, organizationId, shipmentId, result.code)
        } else {
          const { outcome: _, ...state } = result
          cancelRequested = await storeCreated(ctx, { organizationId, connectionId, shipmentId }, state)
        }
      } finally {
        // Without an answer stored, the queue's retry must be able to ask again at once; with one, this matches nothing.
        try {
          await releaseShipmentCreate(ctx, organizationId, shipmentId, lease)
        } catch (error) {
          ctx.log.error('shipment create lease not released', { organizationId, shipmentId, error: describeFailure(error) })
        }
      }
      await finishSyncRun(ctx, organizationId, connectionId, 'shipments_create', { [outcome]: 1 })
      if (!cancelRequested) return
      // A person asked to cancel it while the Carrier was being asked: now it has an id to cancel by. Lost, the tick
      // finds the Shipment due.
      await afterCommit(ctx, { job: shipmentsTrackRef.name, organizationId, connectionId }, () =>
        ctx.queue.enqueue(shipmentsTrackRef, { organizationId, connectionId }, { coalesceKey: coalesceKeys.shipmentsTrack(connectionId) }),
      )
    })
  },
})
