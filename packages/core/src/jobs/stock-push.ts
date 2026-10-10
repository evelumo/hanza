import type { StockLevel } from '@hanza/connector-sdk'
import { decideStockPush, OFFER_ENDED_CODE } from '../catalog/offer-push'
import { listOffersAwaitingStockPush, recordStockPushOutcomes, type StockPushOutcome } from '../catalog/offers'
import { finishSyncRun, recordSkippedSyncRun } from '../connections/sync-state'
import { defineJob } from '../jobs'
import { getChannelAvailability } from '../stock/channel-available'
import { withSyncRun } from '../sync/begin-run'
import { parseStockPushResults } from '../sync/pull-result'
import { runConnectorCall } from '../sync/run-connector'
import { isStockPushHeld } from '../sync/stock-push-hold'
import { coalesceKeys, stockPushRef } from './refs'

const BATCH_SIZE = 100
const MAX_BATCHES = 10

/**
 * Sends Channel Available (ADR 0013) for every linked Offer of the Connection whose push sequence
 * moved since its last push. The Offers are read before the rules and Available, so a change after
 * that read leaves its bump ahead of the sequence marked here.
 *
 * Offers the Channel reports ended follow ADR 0022 (see `decideStockPush`). An Offer the Channel refuses
 * on its own is recorded as rejected and counts as handled; the others of the call count as pushed and the
 * Connection stays healthy. Only a failure of the whole call fails the run.
 *
 * Held, without opening the Connection, until its Order feed has caught up since it was created or restarted (#125):
 * the Orders pull that catches up enqueues the push. A held run records only its start and end, so the tick
 * re-enqueues it at the usual interval and the Offers keep their pending push sequence.
 */
export const stockPushJob = defineJob({
  ...stockPushRef,
  async handler(ctx, payload, run) {
    const { organizationId, connectionId } = payload
    if (await isStockPushHeld(ctx, organizationId, connectionId)) {
      ctx.log.info('stock push held until the Order feed has caught up', { organizationId, connectionId })
      await recordSkippedSyncRun(ctx, organizationId, connectionId, 'stock_push')
      return
    }
    const input = { organizationId, connectionId, stream: 'stock_push', capability: 'stock.push', run } as const
    await withSyncRun(ctx, input, async ({ connector, context, scope }) => {
      const reopensSoldOutOffers = connector.reopensSoldOutOffers === true
      const totals = { pushed: 0, rejected: 0, skipped: 0 }
      let calledChannel = false
      let lastBatchFull = false
      for (let batch = 0; batch < MAX_BATCHES; batch++) {
        const offers = await listOffersAwaitingStockPush(ctx, organizationId, connectionId, BATCH_SIZE)
        if (offers.length === 0) {
          lastBatchFull = false
          break
        }
        const channelAvailability = await getChannelAvailability(ctx.db, organizationId, connectionId, offers.map((offer) => offer.productId))
        const outcomes: StockPushOutcome[] = []
        const toPush: Array<{ offerId: string; seq: number; wasEnded: boolean; level: StockLevel }> = []
        for (const offer of offers) {
          const available = channelAvailability.get(offer.productId) ?? 0
          const decision = decideStockPush(available, offer.publication, reopensSoldOutOffers)
          if (decision === 'push') {
            toPush.push({
              offerId: offer.offerId,
              seq: offer.seq,
              wasEnded: offer.publication?.status === 'ended',
              level: { offerExternalId: offer.externalId, sku: offer.sku, available },
            })
          } else if (decision === 'reject') {
            outcomes.push({ offerId: offer.offerId, seq: offer.seq, outcome: { rejected: OFFER_ENDED_CODE } })
          } else {
            outcomes.push({ offerId: offer.offerId, seq: offer.seq, outcome: { skipped: true } })
          }
        }

        if (toPush.length > 0) {
          const levels = toPush.map((item) => item.level)
          const results = await runConnectorCall(ctx, scope, async () =>
            parseStockPushResults(await connector.capabilities['stock.push']!(context, levels), levels),
          )
          calledChannel = true
          for (const { offerId, seq, wasEnded, level } of toPush) {
            const result = results.get(level.offerExternalId) ?? { outcome: 'ok' as const }
            if (result.outcome === 'rejected') {
              outcomes.push({ offerId, seq, outcome: { rejected: result.code } })
            } else if (result.outcome === 'ended') {
              outcomes.push({ offerId, seq, outcome: { pushed: level.available }, publication: { status: 'ended', endedReason: 'sold_out' } })
            } else {
              // A number accepted for an ended Offer reopened it (it was pushed only because it may be reopened).
              const reopened = wasEnded && level.available > 0
              outcomes.push({
                offerId,
                seq,
                outcome: { pushed: level.available },
                ...(reopened ? { publication: { status: 'active', endedReason: null } } : {}),
              })
            }
          }
        }

        await recordStockPushOutcomes(ctx, organizationId, outcomes)
        for (const { outcome } of outcomes) {
          if ('pushed' in outcome) totals.pushed++
          else if ('rejected' in outcome) totals.rejected++
          else totals.skipped++
        }
        lastBatchFull = offers.length === BATCH_SIZE
      }

      await finishSyncRun(ctx, organizationId, connectionId, 'stock_push', totals, { calledChannel })
      if (lastBatchFull) {
        await ctx.queue.enqueue(stockPushRef, { organizationId, connectionId }, { coalesceKey: coalesceKeys.stockPush(connectionId) })
      }
    })
  },
})
