import { classifyConnectorError } from '@hanza/connector-sdk'
import { finishSyncRun } from '../connections/sync-state'
import { defineJob } from '../jobs'
import { abandonStatusPush, isStatusPushPending, markStatusPushed } from '../orders/status-push'
import { reassertOrderStock, requestStockPushAfterCommit } from '../stock/push'
import { withSyncRun } from '../sync/begin-run'
import { runConnectorCall } from '../sync/run-connector'
import { ordersUpdateStatusRef } from './refs'

/**
 * Tells the Channel the Order's current status (not the one at enqueue time) while a push is pending, so
 * coalesced requests lose nothing and a request whose push already happened sends nothing (ADR 0012). A push that
 * reached the Channel is followed by a stock push of the Order's Offers there (ADR 0023).
 */
export const ordersUpdateStatusJob = defineJob({
  ...ordersUpdateStatusRef,
  async handler(ctx, payload, run) {
    const { organizationId, orderId } = payload
    const order = await ctx.db.order.findFirst({
      where: { id: orderId, organizationId },
      select: { externalId: true, phase: true, connectionId: true, statusPushSeq: true, statusPushDueAt: true },
    })
    if (!order) {
      ctx.log.info('status push skipped: no such Order', { organizationId, orderId })
      return
    }
    if (!isStatusPushPending(order)) return
    const { connectionId, statusPushSeq: seq } = order
    const input = { organizationId, connectionId, stream: 'order_status_push', capability: 'orders.updateStatus', run } as const
    await withSyncRun(ctx, input, async ({ connector, context, scope, channelRequests }) => {
      let refused = false
      try {
        await runConnectorCall(ctx, scope, async () => {
          try {
            return await connector.capabilities['orders.updateStatus']!(context, { orderExternalId: order.externalId, phase: order.phase })
          } catch (error) {
            refused = classifyConnectorError(error).kind === 'permanent'
            throw error
          }
        })
      } catch (error) {
        // Re-sending a status the Channel refused for good would fail every sweep: a person decides instead.
        if (refused) await abandonStatusPush(ctx, organizationId, orderId, seq)
        throw error
      }
      // A connector resolves without a request when the Channel has no equivalent status; that
      // run proves nothing about the Connection, so it must not clear auth_expired (like an empty stock push).
      const calledChannel = channelRequests() > 0
      // The Channel may have changed its own count with the status it was told (a shop puts a cancelled order's
      // units back), whichever of this job and the stock push ran first: its Offers are sent again (ADR 0023).
      // Marked before the push is cleared, so a run that dies in between sends the status and marks again,
      // instead of finding nothing pending. A retry may mark twice: a mark only makes the next push send the number.
      const toPush = calledChannel ? await reassertOrderStock(ctx, organizationId, orderId) : []
      await markStatusPushed(ctx, organizationId, orderId, seq)
      await finishSyncRun(ctx, organizationId, connectionId, 'order_status_push', { pushed: 1 }, { calledChannel })
      // A lost enqueue leaves the marked Offers to the tick's stock push (ADR 0010).
      await requestStockPushAfterCommit(ctx, organizationId, toPush)
    })
  },
})
