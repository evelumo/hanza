import { classifyConnectorError } from '@hanza/connector-sdk'
import { finishSyncRun } from '../connections/sync-state'
import { defineJob } from '../jobs'
import { abandonStatusPush, isStatusPushPending, markStatusPushed } from '../orders/status-push'
import { withSyncRun } from '../sync/begin-run'
import { runConnectorCall } from '../sync/run-connector'
import { ordersUpdateStatusRef } from './refs'

/**
 * Tells the Channel the Order's current status (not the one at enqueue time) while a push is pending, so
 * coalesced requests lose nothing and a request whose push already happened sends nothing (ADR 0011).
 */
export const ordersUpdateStatusJob = defineJob({
  ...ordersUpdateStatusRef,
  async handler(ctx, payload, run) {
    const { organizationId, orderId } = payload
    const order = await ctx.db.order.findFirst({
      where: { id: orderId, organizationId },
      select: { externalId: true, status: true, connectionId: true, statusPushSeq: true, statusPushDueAt: true },
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
            return await connector.capabilities['orders.updateStatus']!(context, { orderExternalId: order.externalId, status: order.status })
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
      await markStatusPushed(ctx, organizationId, orderId, seq)
      // A connector resolves without a request when the Channel has no equivalent status; that
      // run proves nothing about the Connection, so it must not clear auth_expired (like an empty stock push).
      await finishSyncRun(ctx, organizationId, connectionId, 'order_status_push', { pushed: 1 }, { calledChannel: channelRequests() > 0 })
    })
  },
})
