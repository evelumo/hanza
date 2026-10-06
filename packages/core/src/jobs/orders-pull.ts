import { isCursorExpiredError, isOrderUpdate, type OrderFeedItem, type PullResult } from '@hanza/connector-sdk'
import { finishSyncRun, restartOrderFeed, saveSyncCursor } from '../connections/sync-state'
import { defineJob } from '../jobs'
import { importOrder } from '../orders/import'
import { rematchUnmatchedLines } from '../orders/rematch'
import { applyOrderUpdate } from '../orders/update'
import { withSyncRun } from '../sync/begin-run'
import { parseOrdersPage } from '../sync/pull-result'
import { runConnectorCall } from '../sync/run-connector'
import { coalesceKeys, ordersPullRef } from './refs'

const MAX_PAGES = 20

/**
 * Follows the Channel's incremental Order feed from the persisted cursor. The cursor is saved after
 * each page is imported, so a crash in between re-pulls that page; `importOrder` and `applyOrderUpdate`
 * are idempotent. An expired cursor restarts the feed from null once per run (`restartOrderFeed`);
 * expiring again, or for cursor null, fails the run as permanent like any `PermanentError`.
 */
export const ordersPullJob = defineJob({
  ...ordersPullRef,
  async handler(ctx, payload, run) {
    const { organizationId, connectionId, trigger } = payload
    const input = { organizationId, connectionId, stream: 'orders_pull', capability: 'orders.pull', run } as const
    await withSyncRun(ctx, input, async (sync) => {
      const { connector, context, scope } = sync
      const counts = { pulled: 0, imported: 0, factsApplied: 0, pages: 0 }
      let updatesIgnored = 0
      let feedRestarts = 0
      let cursor = sync.cursor
      let hasMore = true
      while (counts.pages < MAX_PAGES && hasMore) {
        const from = cursor
        const result: PullResult<OrderFeedItem> | 'expired' = await runConnectorCall(ctx, scope, async () => {
          try {
            return parseOrdersPage(await connector.capabilities['orders.pull']!(context, from), from)
          } catch (error) {
            if (from !== null && feedRestarts === 0 && isCursorExpiredError(error)) return 'expired'
            throw error
          }
        })
        if (result === 'expired') {
          ctx.log.warn('order feed restarted: the Channel no longer has the cursor position', { organizationId, connectionId })
          await restartOrderFeed(ctx, organizationId, connectionId)
          feedRestarts++
          cursor = null
          continue
        }
        for (const item of result.items) {
          if (isOrderUpdate(item)) {
            const applied = await applyOrderUpdate(ctx, organizationId, connectionId, item)
            if (applied.found) counts.factsApplied += applied.factsApplied
            else updatesIgnored++
            continue
          }
          const imported = await importOrder(ctx, organizationId, connectionId, item)
          if (imported.created) counts.imported++
          counts.factsApplied += imported.factsApplied
        }
        await saveSyncCursor(ctx, organizationId, connectionId, 'orders_pull', result.nextCursor)
        counts.pulled += result.items.length
        counts.pages++
        cursor = result.nextCursor
        hasMore = result.hasMore
      }

      // Written only when they happened, so the usual summary stays as it was.
      const extra = { ...(updatesIgnored > 0 ? { updatesIgnored } : {}), ...(feedRestarts > 0 ? { feedRestarts } : {}) }
      await finishSyncRun(ctx, organizationId, connectionId, 'orders_pull', { ...counts, ...extra })
      // Catches lines that missed every other rematch trigger, e.g. an Order imported while its
      // Product was being created. Cheap when nothing can match.
      await rematchUnmatchedLines(ctx, organizationId)
      if (hasMore) {
        // Runs after this one finishes (coalesced), so a large backlog never holds a worker slot for long.
        await ctx.queue.enqueue(ordersPullRef, { organizationId, connectionId, trigger }, { coalesceKey: coalesceKeys.ordersPull(connectionId) })
      }
    })
  },
})
