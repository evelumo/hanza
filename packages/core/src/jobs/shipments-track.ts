import { classifyConnectorError, type ConnectorErrorKind } from '@hanza/connector-sdk'
import { finishSyncRun } from '../connections/sync-state'
import { defineJob, PermanentJobError, RetryLaterError } from '../jobs'
import { applyShipmentState, keepShipmentState } from '../shipments/apply-state'
import { recordCancelResult } from '../shipments/cancel'
import { parseCancelResult, parseLabel, parseTrackedStates } from '../shipments/carrier-answers'
import { claimDueShipmentChecks, releaseShipmentChecks } from '../shipments/claims'
import { storeShipmentLabel, wantsLabel } from '../shipments/label'
import { SHIPMENT_TRACK_BATCH } from '../shipments/schedule'
import { isFinalStatus } from '../shipments/statuses'
import { withSyncRun } from '../sync/begin-run'
import { runConnectorCall } from '../sync/run-connector'
import { coalesceKeys, shipmentsTrackRef } from './refs'

const MAX_BATCHES = 5

/**
 * Follows the Connection's due Shipments at their Carrier, at most 100 per `shipments.track` call: first the cancels
 * people asked for, then one call for the states, each applied under its Order's lock (the first status that means the
 * Carrier has the parcel ships the Order, ADR 0024), then the Label of every Shipment that is confirmed and has none.
 *
 * Cancelling is done here and not in a job of its own, so one job per Connection is the only writer of what a Carrier
 * says about a Shipment it knows: a cancel and a status of the same Shipment never race, a lost enqueue is found by
 * the same sweep (`nextCheckAt`), and a failure lands on the same stream.
 *
 * The job claims its batch (see `claimDueShipmentChecks`). A Carrier without a Label yet (`TransientError`) is not a
 * failure of the run; the Shipment is asked again at its next check. Any other failure of a call goes the way of
 * every connector call, and the Shipments not handled yet are given back when the queue or a sign-in will retry them
 * soon, or else left to the sweep's retry interval, so a Carrier that refuses for good is asked once per interval.
 */
export const shipmentsTrackJob = defineJob({
  ...shipmentsTrackRef,
  async handler(ctx, payload, run) {
    const { organizationId, connectionId } = payload
    const input = { organizationId, connectionId, stream: 'shipments_track', capability: 'shipments.track', run } as const
    await withSyncRun(ctx, input, async ({ connector, context, scope }) => {
      const { capabilities } = connector
      const totals = { checked: 0, changed: 0, labels: 0, cancelled: 0 }
      const seen: string[] = []
      let calledCarrier = false
      let lastBatchFull = false

      // The kind of the last failed call, to tell a sign-in that is needed (retried when it happened) from a refusal for good.
      const failure: { kind: ConnectorErrorKind | null } = { kind: null }
      const call = <T>(request: () => Promise<T>): Promise<T> => {
        calledCarrier = true
        return runConnectorCall(ctx, scope, async () => {
          try {
            return await request()
          } catch (error) {
            failure.kind = classifyConnectorError(error).kind
            throw error
          }
        })
      }

      for (let batch = 0; batch < MAX_BATCHES; batch++) {
        const ids = await claimDueShipmentChecks(ctx, organizationId, connectionId, SHIPMENT_TRACK_BATCH, seen)
        lastBatchFull = ids.length === SHIPMENT_TRACK_BATCH
        if (ids.length === 0) break
        seen.push(...ids)
        const unhandled = new Set(ids)
        try {
          const shipments = await ctx.db.shipment.findMany({
            where: { organizationId, connectionId, id: { in: ids }, externalId: { not: null } },
            orderBy: { id: 'asc' },
            select: {
              id: true,
              externalId: true,
              status: true,
              cancelRequestedAt: true,
              labelContentType: true,
              order: { select: { buyerDataErasedAt: true } },
            },
          })

          const followed: typeof shipments = []
          for (const shipment of shipments) {
            const cancel = capabilities['shipments.cancel']
            if (shipment.cancelRequestedAt === null || isFinalStatus(shipment.status) || !cancel) {
              followed.push(shipment)
              continue
            }
            const result = await call(async () => parseCancelResult(await cancel(context, { externalId: shipment.externalId! })))
            await recordCancelResult(ctx, organizationId, shipment.id, result)
            if (result.outcome === 'refused') {
              followed.push(shipment)
              continue
            }
            totals.cancelled++
            unhandled.delete(shipment.id)
          }
          if (followed.length === 0) continue

          const externalIds = followed.map((shipment) => shipment.externalId!)
          const states = await call(async () => parseTrackedStates(await capabilities['shipments.track']!(context, externalIds), externalIds))
          for (const shipment of followed) {
            const state = states.get(shipment.externalId!)
            const applied = state
              ? await applyShipmentState(ctx, organizationId, shipment.id, state, 'tracked')
              : await keepShipmentState(ctx, organizationId, shipment.id)
            totals.checked++
            if (applied.applied && applied.status !== shipment.status) totals.changed++

            // An erased Order's Label would print the Buyer's name and address again: it is not fetched back.
            const labelMissing = shipment.labelContentType === null && shipment.order.buyerDataErasedAt === null
            if (applied.applied && wantsLabel(applied.status) && labelMissing) {
              const label = await call(async () => {
                try {
                  return parseLabel(await capabilities['shipments.label']!(context, { externalId: shipment.externalId! }))
                } catch (error) {
                  // The Carrier has none yet: asked again at the Shipment's next check.
                  if (classifyConnectorError(error).kind === 'transient') return null
                  throw error
                }
              })
              if (label && (await storeShipmentLabel(ctx, organizationId, shipment.id, label))) totals.labels++
            }
            unhandled.delete(shipment.id)
          }
        } catch (error) {
          const retriedSoon =
            error instanceof RetryLaterError ||
            (error instanceof PermanentJobError ? failure.kind === 'auth_expired' : run.attempt < run.maxAttempts)
          if (retriedSoon) await releaseShipmentChecks(ctx, organizationId, [...unhandled])
          throw error
        }
      }

      await finishSyncRun(ctx, organizationId, connectionId, 'shipments_track', totals, { calledChannel: calledCarrier })
      if (lastBatchFull) {
        // Runs after this one finishes (coalesced), so a large backlog never holds a worker slot for long.
        await ctx.queue.enqueue(shipmentsTrackRef, { organizationId, connectionId }, { coalesceKey: coalesceKeys.shipmentsTrack(connectionId) })
      }
    })
  },
})
