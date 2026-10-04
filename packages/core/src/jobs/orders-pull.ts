import type { Order, PullResult } from '@hanza/connector-sdk'
import { finishSyncRun, saveSyncCursor } from '../connections/sync-state'
import { defineJob } from '../jobs'
import { importOrder } from '../orders/import'
import { rematchUnmatchedLines } from '../orders/rematch'
import { withSyncRun } from '../sync/begin-run'
import { parseOrdersPage } from '../sync/pull-result'
import { runConnectorCall } from '../sync/run-connector'
import { coalesceKeys, ordersPullRef } from './refs'

const MAX_PAGES = 20

/**
 * Follows the Channel's incremental Order feed from the persisted cursor. The cursor is saved after
 * each page is imported, so a crash in between re-pulls that page; `importOrder` is idempotent.
 */
export const ordersPullJob = defineJob({
  ...ordersPullRef,
  async handler(ctx, payload, run) {
    const { organizationId, connectionId, trigger } = payload
    const input = { organizationId, connectionId, stream: 'orders_pull', capability: 'orders.pull', run } as const
    await withSyncRun(ctx, input, async (sync) => {
      const { connector, context, scope } = sync
      const counts = { pulled: 0, imported: 0, factsApplied: 0, pages: 0 }
      let cursor = sync.cursor
      let hasMore = true
      while (counts.pages < MAX_PAGES && hasMore) {
        const result: PullResult<Order> = await runConnectorCall(ctx, scope, async () =>
          parseOrdersPage(await connector.capabilities['orders.pull']!(context, cursor), cursor),
        )
        for (const order of result.items) {
          const imported = await importOrder(ctx, organizationId, connectionId, order)
          if (imported.created) counts.imported++
          counts.factsApplied += imported.factsApplied
        }
        await saveSyncCursor(ctx, organizationId, connectionId, 'orders_pull', result.nextCursor)
        counts.pulled += result.items.length
        counts.pages++
        cursor = result.nextCursor
        hasMore = result.hasMore
      }

      await finishSyncRun(ctx, organizationId, connectionId, 'orders_pull', counts)
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
