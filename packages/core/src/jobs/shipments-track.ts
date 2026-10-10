import { classifyConnectorError, type ConnectorErrorKind, type ShipmentLabel } from '@hanza/connector-sdk'
import { finishSyncRun } from '../connections/sync-state'
import { defineJob, PermanentJobError, RetryLaterError } from '../jobs'
import { applyShipmentState, keepShipmentState } from '../shipments/apply-state'
import { recordCancelResult } from '../shipments/cancel'
import { parseCancelResult, parseLabel, parseTrackedStates } from '../shipments/carrier-answers'
import { claimDueShipmentChecks, postponeShipmentChecks, releaseShipmentChecks } from '../shipments/claims'
import { giveUpShipmentLabel, storeShipmentLabel, wantsLabel } from '../shipments/label'
import { SHIPMENT_TRACK_BATCH } from '../shipments/schedule'
import { isFinalStatus } from '../shipments/statuses'
import { withSyncRun } from '../sync/begin-run'
import { runConnectorCall } from '../sync/run-connector'
import { coalesceKeys, shipmentsTrackRef } from './refs'

const MAX_BATCHES = 5

/** What a connector that no longer has `shipments.cancel` leaves of a cancel a person asked for. */
const CANCEL_UNSUPPORTED_CODE = 'cancel_unsupported'

/**
 * Follows the Connection's due Shipments at their Carrier, at most 100 per `shipments.track` call: first the cancels
 * people asked for, then one call for the states, each applied under its Order's lock (the first status that means the
 * Carrier has the parcel ships the Order, ADR 0024), then the Label of every Shipment that is confirmed and has none.
 *
 * Cancelling is done here and not in a job of its own, so the run that claimed a Shipment is the only writer of what
 * a Carrier says about it: a cancel and a status of the same Shipment never race, a lost enqueue is found by the same
 * sweep (`nextCheckAt`), and a failure lands on the same stream.
 *
 * The job claims its batch (see `claimDueShipmentChecks`), which is what keeps two runs apart: the Connection's runs
 * are coalesced, but the delayed first check of a new Shipment (`shipments.create`) is a run of its own and may come
 * beside another one. What fails for one Shipment stays that Shipment's: a
 * cancel the Carrier's API refuses, or a Label that cannot be had, never costs the others of the batch their status,
 * since a pickup that is not applied leaves an Order open and its Stock reserved. The failure is recorded like any
 * connector call's, the rest of the batch is tracked and applied, and the first such error is thrown when the batch
 * is done, so the Connection's health shows it. The Shipment whose cancel failed is tracked with the others and
 * asked about again once per retry interval (at once while the queue retries the job). A Label that failed for good
 * (the Carrier refuses, the file is not a Label or is too large) is given up on, so it is not downloaded again at
 * every check; a Carrier without a Label yet (`TransientError`) is not a failure, and is asked again at the next
 * check. A sign-in that is needed or a rate limit concerns every Shipment and stops the run at once, as does a
 * failure of the `shipments.track` call itself: the Shipments not handled yet are given back when the queue or a
 * sign-in will retry them soon, or else left to the sweep's retry interval, so a Carrier that refuses for good is
 * asked once per interval.
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
      // A cancel that came in while its Shipment was being tracked: it goes out with a run right after this one.
      let cancelsWaiting = false
      // The first failure that was one Shipment's own; thrown once its batch is done.
      let isolated: { error: unknown } | null = null

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
      /** A failed call that says nothing can be done for any Shipment right now. `error` is what `call` threw. */
      const stopsRun = (error: unknown) => error instanceof RetryLaterError || (error instanceof PermanentJobError && failure.kind === 'auth_expired')
      /** Whether the queue, or a sign-in, runs this job again soon after `error` stopped it. */
      const retriedSoon = (error: unknown) =>
        error instanceof RetryLaterError || (error instanceof PermanentJobError ? failure.kind === 'auth_expired' : run.attempt < run.maxAttempts)
      /** The same for a failure that was one Shipment's own, which is never a sign-in or a rate limit. */
      const retriesJob = (error: unknown) => !(error instanceof PermanentJobError) && run.attempt < run.maxAttempts

      for (let batch = 0; batch < MAX_BATCHES && isolated === null; batch++) {
        const ids = await claimDueShipmentChecks(ctx, organizationId, connectionId, SHIPMENT_TRACK_BATCH, seen)
        lastBatchFull = ids.length === SHIPMENT_TRACK_BATCH
        if (ids.length === 0) break
        seen.push(...ids)
        const unhandled = new Set(ids)
        const cancelAsked = new Set<string>()
        const cancelFailed: string[] = []
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
              labelFailureCode: true,
              order: { select: { buyerDataErasedAt: true } },
            },
          })

          const followed: typeof shipments = []
          // After a cancel that failed for a passing reason the Carrier is likely not answering: the other cancels
          // wait for the next run instead of each timing out in turn.
          let cancelling = true
          for (const shipment of shipments) {
            if (shipment.cancelRequestedAt === null || isFinalStatus(shipment.status)) {
              followed.push(shipment)
              continue
            }
            const cancel = capabilities['shipments.cancel']
            if (!cancel) {
              // The connector lost the capability after the person asked: the request is over, and says why.
              await recordCancelResult(ctx, organizationId, shipment.id, { outcome: 'refused', code: CANCEL_UNSUPPORTED_CODE })
              followed.push(shipment)
              continue
            }
            if (!cancelling) {
              followed.push(shipment)
              continue
            }
            cancelAsked.add(shipment.id)
            let result
            try {
              result = await call(async () => parseCancelResult(await cancel(context, { externalId: shipment.externalId! })))
            } catch (error) {
              if (stopsRun(error)) throw error
              isolated ??= { error }
              cancelFailed.push(shipment.id)
              cancelling = error instanceof PermanentJobError
              // Still tracked: whether the cancel went through or not, its status is the Carrier's to say.
              followed.push(shipment)
              continue
            }
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
            if (applied.applied && applied.cancelRequested && !cancelAsked.has(shipment.id)) cancelsWaiting = true

            // An erased Order's Label would print the Buyer's name and address again: it is not fetched back.
            const labelMissing = shipment.labelContentType === null && shipment.labelFailureCode === null && shipment.order.buyerDataErasedAt === null
            if (applied.applied && wantsLabel(applied.status) && labelMissing) {
              let invalid = false
              let label: ShipmentLabel | null = null
              try {
                label = await call(async () => {
                  let raw: unknown
                  try {
                    raw = await capabilities['shipments.label']!(context, { externalId: shipment.externalId! })
                  } catch (error) {
                    // The Carrier has none yet: asked again at the Shipment's next check.
                    if (classifyConnectorError(error).kind === 'transient') return null
                    throw error
                  }
                  try {
                    return parseLabel(raw)
                  } catch (error) {
                    invalid = true
                    throw error
                  }
                })
              } catch (error) {
                if (stopsRun(error)) throw error
                isolated ??= { error }
                // For good: asking again would fetch, or be refused, the same file at every check.
                if (error instanceof PermanentJobError) await giveUpShipmentLabel(ctx, organizationId, shipment.id, invalid ? 'invalid' : 'refused')
              }
              if (label) {
                const stored = await storeShipmentLabel(ctx, organizationId, shipment.id, label)
                if (stored === 'stored') totals.labels++
                if (stored === 'too_large') await giveUpShipmentLabel(ctx, organizationId, shipment.id, 'too_large', { bytes: label.data.byteLength })
              }
            }
            unhandled.delete(shipment.id)
          }
          // Its cancel is asked for again with the job's retry, or else once per retry interval, not at every check.
          if (isolated !== null && !retriesJob(isolated.error)) await postponeShipmentChecks(ctx, organizationId, cancelFailed)
        } catch (error) {
          if (retriedSoon(error)) await releaseShipmentChecks(ctx, organizationId, [...unhandled])
          throw error
        }
      }

      if (isolated !== null) throw isolated.error
      await finishSyncRun(ctx, organizationId, connectionId, 'shipments_track', totals, { calledChannel: calledCarrier })
      if (lastBatchFull || cancelsWaiting) {
        // Runs after this one finishes (coalesced), so a large backlog never holds a worker slot for long.
        await ctx.queue.enqueue(shipmentsTrackRef, { organizationId, connectionId }, { coalesceKey: coalesceKeys.shipmentsTrack(connectionId) })
      }
    })
  },
})
