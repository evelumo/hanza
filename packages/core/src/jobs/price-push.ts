import type { OfferPrice } from '@hanza/connector-sdk'
import { finishSyncRun } from '../connections/sync-state'
import { defineJob } from '../jobs'
import { decidePricePush } from '../prices/price'
import { listOffersAwaitingPricePush, markOffersPriceHandled } from '../prices/push'
import { withSyncRun } from '../sync/begin-run'
import { runConnectorCall } from '../sync/run-connector'
import { coalesceKeys, pricePushRef } from './refs'

const BATCH_SIZE = 100
const MAX_BATCHES = 10

/**
 * Sends the effective price of every linked Offer of the Connection whose price push sequence moved.
 * Offers with nothing to send (no price, unknown or different currency) are marked handled too, so they
 * cannot fill every batch; whatever can make them pushable bumps them again.
 */
export const pricePushJob = defineJob({
  ...pricePushRef,
  async handler(ctx, payload, run) {
    const { organizationId, connectionId } = payload
    const input = { organizationId, connectionId, stream: 'price_push', capability: 'price.push', run } as const
    await withSyncRun(ctx, input, async ({ connector, context, scope }) => {
      let pushed = 0
      let skipped = 0
      let lastBatchFull = false
      for (let batch = 0; batch < MAX_BATCHES; batch++) {
        const offers = await listOffersAwaitingPricePush(ctx, organizationId, connectionId, BATCH_SIZE)
        if (offers.length === 0) {
          lastBatchFull = false
          break
        }
        const decided = offers.map((offer) => ({ offer, decision: decidePricePush(offer.effective, offer.channelCurrency) }))
        const prices: OfferPrice[] = decided.flatMap(({ offer, decision }) =>
          'push' in decision ? [{ offerExternalId: offer.externalId, sku: offer.sku, price: decision.push }] : [],
        )
        if (prices.length > 0) {
          await runConnectorCall(ctx, scope, () => connector.capabilities['price.push']!(context, prices))
        }
        await markOffersPriceHandled(
          ctx,
          organizationId,
          decided.map(({ offer, decision }) => ({ offerId: offer.offerId, seq: offer.seq, pushed: 'push' in decision ? decision.push : null })),
        )
        pushed += prices.length
        skipped += offers.length - prices.length
        lastBatchFull = offers.length === BATCH_SIZE
      }

      await finishSyncRun(ctx, organizationId, connectionId, 'price_push', { pushed, skipped }, { calledChannel: pushed > 0 })
      if (lastBatchFull) {
        await ctx.queue.enqueue(pricePushRef, { organizationId, connectionId }, { coalesceKey: coalesceKeys.pricePush(connectionId) })
      }
    })
  },
})
