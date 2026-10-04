import { listOffersAwaitingStockPush, markOffersPushed } from '../catalog/offers'
import { finishSyncRun } from '../connections/sync-state'
import { defineJob } from '../jobs'
import { getAvailability } from '../stock/availability'
import { beginSyncRun } from '../sync/begin-run'
import { runConnectorCall } from '../sync/run-connector'
import { coalesceKeys, stockPushRef } from './refs'

const BATCH_SIZE = 100
const MAX_BATCHES = 10

/** Sends max(0, Available) for every linked Offer of the Connection whose push sequence moved since its last push. */
export const stockPushJob = defineJob({
  ...stockPushRef,
  async handler(ctx, payload, run) {
    const { organizationId, connectionId } = payload
    const sync = await beginSyncRun(ctx, { organizationId, connectionId, stream: 'stock_push', capability: 'stock.push', run })
    if (!sync) return
    const { connector, context, scope } = sync

    let pushed = 0
    let lastBatchFull = false
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const offers = await listOffersAwaitingStockPush(ctx, organizationId, connectionId, BATCH_SIZE)
      if (offers.length === 0) {
        lastBatchFull = false
        break
      }
      const availability = await getAvailability(ctx.db, organizationId, offers.map((offer) => offer.productId))
      const levels = offers.map((offer) => ({
        offerId: offer.offerId,
        seq: offer.seq,
        offerExternalId: offer.externalId,
        sku: offer.sku,
        available: Math.max(0, availability.get(offer.productId)?.available ?? 0),
      }))
      await runConnectorCall(ctx, scope, () =>
        connector.capabilities['stock.push']!(
          context,
          levels.map(({ offerExternalId, sku, available }) => ({ offerExternalId, sku, available })),
        ),
      )
      await markOffersPushed(ctx, organizationId, levels.map(({ offerId, seq, available }) => ({ offerId, seq, available })))
      pushed += levels.length
      lastBatchFull = offers.length === BATCH_SIZE
    }

    await finishSyncRun(ctx, organizationId, connectionId, 'stock_push', { pushed }, { calledChannel: pushed > 0 })
    if (lastBatchFull) {
      await ctx.queue.enqueue(stockPushRef, { organizationId, connectionId }, { coalesceKey: coalesceKeys.stockPush(connectionId) })
    }
  },
})
