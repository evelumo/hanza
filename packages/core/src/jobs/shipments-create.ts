import { findShippingService, shipmentRequestProblem, type ShipmentState } from '@hanza/connector-sdk'
import { afterCommit } from '../after-commit'
import { finishSyncRun } from '../connections/sync-state'
import type { Context } from '../context'
import { describeFailure } from '../describe-failure'
import { isUniqueViolation } from '../errors'
import { defineJob } from '../jobs'
import { storedBuyerDataSelect } from '../privacy/buyer-data'
import { isRefusedBeforeSending } from '../rate-limit/limited-fetch'
import { applyShipmentState, failShipment, timeOutShipmentRequest } from '../shipments/apply-state'
import { buildShipmentRequest } from '../shipments/build-request'
import { cancelUnansweredShipment } from '../shipments/cancel'
import { parseCreateResult } from '../shipments/carrier-answers'
import { claimShipmentCreate, holdShipmentCreate, releaseShipmentCreate } from '../shipments/claims'
import { confirmationTimedOut, databaseNow } from '../shipments/schedule'
import { withSyncRun } from '../sync/begin-run'
import { runConnectorCall } from '../sync/run-connector'
import { coalesceKeys, shipmentsCreateRef, shipmentsTrackRef } from './refs'

/**
 * Stores the Shipment the Carrier answered with; true when a cancel is waiting for it. An answer naming a Shipment
 * another row already holds means the connector did not key the request by its `reference`: asking again would only
 * repeat it, so the Shipment fails. An answer for a Shipment that was made final meanwhile is dropped, and the
 * Carrier's id of it is logged, because that Shipment exists at the Carrier and no row follows it.
 */
async function storeCreated(
  ctx: Context,
  ids: { organizationId: string; connectionId: string; shipmentId: string },
  state: ShipmentState,
): Promise<boolean> {
  const { organizationId, shipmentId } = ids
  try {
    const applied = await applyShipmentState(ctx, organizationId, shipmentId, state, 'created')
    if (applied.applied) return applied.cancelRequested
    // Ids only: the Carrier's id is what a person looks the parcel up by.
    ctx.log.error('shipment create answer dropped', { ...ids, externalId: state.externalId, reason: applied.reason })
    return false
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    ctx.log.error('shipment create answered with the id of another Shipment', ids)
    // The Carrier answered: nothing about this request is unknown.
    await failShipment(ctx, organizationId, shipmentId, 'duplicate_external_id', { answered: true })
    return false
  }
}

/**
 * Asks the Carrier for a Shipment that is still `requested` and stores its answer (ADR 0023). It never calls the
 * connector for a Shipment that has an `externalId` or left `requested`, so a duplicate or late job does nothing.
 *
 * The crash this is built around: the Carrier made the Shipment and the answer never reached the row (the worker
 * died, the response timed out, the write failed). The row then still says `requested`, and the connector, which
 * must return the Shipment an earlier call with the same `reference` made, gives that one back when it is asked
 * again. But a Carrier without an idempotency key can only do that by looking the Shipment up, and its list may lag
 * behind its own create, so asking again at once would buy a second parcel. The create lease is what holds the rule
 * of the SDK's contract: after a call whose outcome is not known, nobody asks for this Shipment again until
 * `SHIPMENT_CREATE_RETRY_DELAY_MS` has passed. A job that comes earlier, the queue's own retry included, returns
 * without doing anything and without counting an attempt; the sweep of `sync.tick` brings the Shipment back when the
 * wait is over. Only a call that failed before anything that could make a Shipment was sent (Hanza's own rate
 * limiter refusing the request) gives the lease back and is retried by the queue as usual. A Connection that cannot
 * be opened fails before the lease is taken.
 *
 * A failure of the call goes the way of every connector call (`runConnectorCall`): the Connection's health and the
 * `shipments_create` stream record it and the Shipment keeps waiting. A transient failure marks the Connection
 * failing at once, since no retry of this job will ask again. Only the Carrier refusing the request, the Buyer data
 * being gone, or 24 hours without an answer fail the Shipment itself.
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
        createLeaseUntil: true,
        createdAt: true,
        order: { select: storedBuyerDataSelect },
      },
    })
    if (!shipment) {
      ctx.log.info('shipment create skipped: no such Shipment', { organizationId, shipmentId })
      return
    }
    if (shipment.status !== 'requested' || shipment.externalId !== null) return
    const now = await databaseNow(ctx.db)
    if (shipment.createLeaseUntil !== null && shipment.createLeaseUntil > now) {
      // Another job is asking, or an earlier call's outcome is not known yet: not this job's turn, and not an attempt.
      ctx.log.info('shipment create skipped: the lease is in force', { organizationId, shipmentId })
      return
    }
    if (shipment.cancelRequestedAt !== null) {
      // Asked to be cancelled while an earlier run was asking the Carrier, or waiting to ask again: there is nothing
      // at the Carrier that Hanza knows of, so it is cancelled instead of being asked for once more.
      await cancelUnansweredShipment(ctx, organizationId, shipmentId)
      return
    }
    if (confirmationTimedOut(shipment.status, shipment.createdAt, now)) {
      await timeOutShipmentRequest(ctx, organizationId, shipmentId)
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
    await withSyncRun(ctx, input, async ({ connector, context, scope, writesSent }) => {
      const untouched = () => finishSyncRun(ctx, organizationId, connectionId, 'shipments_create', {}, { calledChannel: false })
      // The connector may have changed since the person asked: it is still only sent what fits a service it declares.
      const service = findShippingService(connector, request.service)
      if (!service || shipmentRequestProblem(service, request) !== null) {
        await failShipment(ctx, organizationId, shipmentId, 'service_unavailable')
        return untouched()
      }
      const lease = await claimShipmentCreate(ctx, organizationId, shipmentId)
      if (lease === null) return untouched()

      const sentBefore = writesSent()
      let refused = false
      let cancelRequested = false
      let outcome: 'created' | 'rejected'
      try {
        // This job does not ask again whatever the queue does, so a transient failure is its last word.
        const lastWord = { ...scope, run: { ...run, attempt: Math.max(run.attempt, run.maxAttempts) } }
        const result = await runConnectorCall(ctx, lastWord, async () => {
          try {
            return parseCreateResult(await connector.capabilities['shipments.create']!(context, request))
          } catch (error) {
            refused = isRefusedBeforeSending(error)
            throw error
          }
        })
        outcome = result.outcome
        if (result.outcome === 'rejected') {
          await failShipment(ctx, organizationId, shipmentId, result.code, { answered: true })
        } else {
          const { outcome: _, ...state } = result
          cancelRequested = await storeCreated(ctx, { organizationId, connectionId, shipmentId }, state)
        }
      } catch (error) {
        // The call threw, or its answer could not be stored. Nothing that could make a Shipment left for the Carrier:
        // the queue's retry may ask at once. Anything else: a Shipment may exist there, and the wait starts.
        const neverAsked = refused && writesSent() === sentBefore
        try {
          if (neverAsked) await releaseShipmentCreate(ctx, organizationId, shipmentId, lease)
          else await holdShipmentCreate(ctx, organizationId, shipmentId, lease)
        } catch (leaseError) {
          // The lease taken with the claim still stands, so nobody asks before it runs out.
          ctx.log.error('shipment create lease not settled', { organizationId, shipmentId, error: describeFailure(leaseError) })
        }
        throw error
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
