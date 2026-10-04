import type { Offer, PullResult } from '@hanza/connector-sdk'
import { upsertOffers } from '../catalog/offers'
import { finishSyncRun } from '../connections/sync-state'
import { defineJob } from '../jobs'
import { rematchUnmatchedLines } from '../orders/rematch'
import { requestStockPush } from '../stock/push'
import { withSyncRun } from '../sync/begin-run'
import { parseOffersPage } from '../sync/pull-result'
import { runConnectorCall } from '../sync/run-connector'
import { coalesceKeys, offersPullRef, ordersPullRef } from './refs'

const MAX_PAGES = 50

/** Reads every Offer on the Channel; Offers that disappeared there are left as they are. */
export const offersPullJob = defineJob({
  ...offersPullRef,
  async handler(ctx, payload, run) {
    const { organizationId, connectionId, trigger } = payload
    const input = { organizationId, connectionId, stream: 'offers_pull', capability: 'offers.pull', run } as const
    await withSyncRun(ctx, input, async ({ connector, context, scope }) => {
      const seenAt = new Date()
      const counts = { seen: 0, created: 0, updated: 0, linked: 0 }
      let cursor: string | null = null
      let hasMore = true
      for (let page = 0; page < MAX_PAGES && hasMore; page++) {
        const result: PullResult<Offer> = await runConnectorCall(ctx, scope, async () =>
          parseOffersPage(await connector.capabilities['offers.pull']!(context, cursor), cursor),
        )
        if (result.items.length > 0) {
          const upserted = await upsertOffers(ctx, organizationId, connectionId, result.items, seenAt)
          counts.seen += result.items.length
          counts.created += upserted.created
          counts.updated += upserted.updated
          counts.linked += upserted.linked
        }
        cursor = result.nextCursor
        hasMore = result.hasMore
      }
      // Offers past the limit are not read at all; say so where a person looks.
      const truncated = hasMore
      if (truncated) {
        ctx.log.error('offers pull stopped at the page limit; later Offers were not read', { organizationId, connectionId, pages: MAX_PAGES })
      }

      await finishSyncRun(ctx, organizationId, connectionId, 'offers_pull', truncated ? { ...counts, truncated: 1 } : counts)
      // Every run, not only when this one linked an Offer: a retry of a run that linked on an
      // earlier page sees linked 0. Cheap when nothing can match (the candidate query is empty).
      await rematchUnmatchedLines(ctx, organizationId)
      if (counts.linked > 0) await requestStockPush(ctx, organizationId, [connectionId])
      if (trigger === 'manual') {
        await ctx.queue.enqueue(
          ordersPullRef,
          { organizationId, connectionId, trigger: 'manual' },
          { coalesceKey: coalesceKeys.ordersPull(connectionId) },
        )
      }
    })
  },
})
