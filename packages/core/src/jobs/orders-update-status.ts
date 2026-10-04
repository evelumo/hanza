import { finishSyncRun } from '../connections/sync-state'
import { defineJob } from '../jobs'
import { beginSyncRun } from '../sync/begin-run'
import { runConnectorCall } from '../sync/run-connector'
import { ordersUpdateStatusRef } from './refs'

/** Tells the Channel the Order's current status (not the one at enqueue time), so coalesced requests lose nothing. */
export const ordersUpdateStatusJob = defineJob({
  ...ordersUpdateStatusRef,
  async handler(ctx, payload, run) {
    const { organizationId, orderId } = payload
    const order = await ctx.db.order.findFirst({
      where: { id: orderId, organizationId },
      select: { externalId: true, status: true, connectionId: true },
    })
    if (!order) {
      ctx.log.info('status push skipped: no such Order', { organizationId, orderId })
      return
    }
    const { connectionId } = order
    const sync = await beginSyncRun(ctx, {
      organizationId,
      connectionId,
      stream: 'order_status_push',
      capability: 'orders.updateStatus',
      run,
    })
    if (!sync) return
    const { connector, context, scope } = sync

    await runConnectorCall(ctx, scope, () =>
      connector.capabilities['orders.updateStatus']!(context, { orderExternalId: order.externalId, status: order.status }),
    )
    await finishSyncRun(ctx, organizationId, connectionId, 'order_status_push', { pushed: 1 })
  },
})
