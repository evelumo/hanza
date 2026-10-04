import { offerSchema, type Offer, type PullResult } from '@hanza/connector-sdk'
import { upsertOffers } from '../catalog/offers'
import { finishSyncRun } from '../connections/sync-state'
import { defineJob } from '../jobs'
import { rematchUnmatchedLines } from '../orders/rematch'
import { requestStockPush } from '../stock/push'
import { beginSyncRun } from '../sync/begin-run'
import { pullResultSchema } from '../sync/pull-result'
import { runConnectorCall } from '../sync/run-connector'
import { coalesceKeys, offersPullRef, ordersPullRef } from './refs'

const MAX_PAGES = 50
const pageSchema = pullResultSchema(offerSchema)

/** Reads every Offer on the Channel; Offers that disappeared there are left as they are. */
export const offersPullJob = defineJob({
  ...offersPullRef,
  async handler(ctx, payload, run) {
    const { organizationId, connectionId, trigger } = payload
    const sync = await beginSyncRun(ctx, { organizationId, connectionId, stream: 'offers_pull', capability: 'offers.pull', run })
    if (!sync) return
    const { connector, context, scope } = sync

    const seenAt = new Date()
    const counts = { seen: 0, created: 0, updated: 0, linked: 0 }
    let cursor: string | null = null
    let hasMore = true
    for (let page = 0; page < MAX_PAGES && hasMore; page++) {
      const result: PullResult<Offer> = await runConnectorCall(ctx, scope, async () =>
        pageSchema.parse(await connector.capabilities['offers.pull']!(context, cursor)),
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
    if (hasMore) ctx.log.info('offers pull stopped at the page limit', { organizationId, connectionId, pages: MAX_PAGES })

    await finishSyncRun(ctx, organizationId, connectionId, 'offers_pull', counts)
    if (counts.linked > 0) {
      await rematchUnmatchedLines(ctx, organizationId)
      await requestStockPush(ctx, organizationId, [connectionId])
    }
    if (trigger === 'manual') {
      await ctx.queue.enqueue(
        ordersPullRef,
        { organizationId, connectionId, trigger: 'manual' },
        { coalesceKey: coalesceKeys.ordersPull(connectionId) },
      )
    }
  },
})
