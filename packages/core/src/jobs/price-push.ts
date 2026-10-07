import type { OfferPrice, PricePushResult } from '@hanza/connector-sdk'
import { finishSyncRun } from '../connections/sync-state'
import { defineJob } from '../jobs'
import { decidePricePush } from '../prices/price'
import { listOffersAwaitingPricePush, markOffersPriceHandled } from '../prices/push'
import { withSyncRun } from '../sync/begin-run'
import { parsePricePushResults } from '../sync/pull-result'
import { runConnectorCall } from '../sync/run-connector'
import { coalesceKeys, pricePushRef } from './refs'

const BATCH_SIZE = 100
const MAX_BATCHES = 10

/**
 * Sends the effective price of every linked Offer of the Connection whose price push sequence moved.
 * Offers with nothing to send (no price, unknown or different currency) are marked handled too, so they
 * cannot fill every batch; whatever can make them pushable bumps them again. An Offer whose price the Channel
 * refuses on its own is recorded as rejected and handled; the others count as pushed and the Connection stays healthy.
 */
export const pricePushJob = defineJob({
  ...pricePushRef,
  async handler(ctx, payload, run) {
    const { organizationId, connectionId } = payload
    const input = { organizationId, connectionId, stream: 'price_push', capability: 'price.push', run } as const
    await withSyncRun(ctx, input, async ({ connector, context, scope }) => {
      let pushed = 0
      let skipped = 0
      let rejected = 0
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
        const results =
          prices.length > 0
            ? await runConnectorCall(ctx, scope, async () =>
                parsePricePushResults(await connector.capabilities['price.push']!(context, prices), prices),
              )
            : new Map<string, PricePushResult>()
        const handled = decided.map(({ offer, decision }) => {
          const result = 'push' in decision ? results.get(offer.externalId) : undefined
          return result?.outcome === 'rejected'
            ? { offerId: offer.offerId, seq: offer.seq, pushed: null, rejected: result.code }
            : { offerId: offer.offerId, seq: offer.seq, pushed: 'push' in decision ? decision.push : null }
        })
        await markOffersPriceHandled(ctx, organizationId, handled)
        const batchRejected = handled.filter((item) => 'rejected' in item).length
        rejected += batchRejected
        pushed += prices.length - batchRejected
        skipped += offers.length - prices.length
        lastBatchFull = offers.length === BATCH_SIZE
      }

      await finishSyncRun(ctx, organizationId, connectionId, 'price_push', { pushed, rejected, skipped }, { calledChannel: pushed + rejected > 0 })
      if (lastBatchFull) {
        await ctx.queue.enqueue(pricePushRef, { organizationId, connectionId }, { coalesceKey: coalesceKeys.pricePush(connectionId) })
      }
    })
  },
})
