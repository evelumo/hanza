import { isChannel } from '@hanza/connector-sdk'
import { listConnectionsForTick } from '../connections/connections'
import type { Context } from '../context'
import { defineJob } from '../jobs'
import { dueStreams, STREAM_CAPABILITIES, type ScheduledStream } from '../sync/schedule'
import { coalesceKeys, offersPullRef, ordersPullRef, pricePushRef, stockPushRef, syncTickRef } from './refs'

async function enqueueStream(ctx: Context, stream: ScheduledStream, organizationId: string, connectionId: string): Promise<void> {
  switch (stream) {
    case 'offers_pull':
      return ctx.queue.enqueue(
        offersPullRef,
        { organizationId, connectionId, trigger: 'schedule' },
        { coalesceKey: coalesceKeys.offersPull(connectionId) },
      )
    case 'orders_pull':
      return ctx.queue.enqueue(
        ordersPullRef,
        { organizationId, connectionId, trigger: 'schedule' },
        { coalesceKey: coalesceKeys.ordersPull(connectionId) },
      )
    case 'stock_push':
      return ctx.queue.enqueue(stockPushRef, { organizationId, connectionId }, { coalesceKey: coalesceKeys.stockPush(connectionId) })
    case 'price_push':
      return ctx.queue.enqueue(pricePushRef, { organizationId, connectionId }, { coalesceKey: coalesceKeys.pricePush(connectionId) })
  }
}

/** One global scheduler: enqueues every due stream a Channel's connector implements, except for Connections waiting for sign-in. */
export const syncTickJob = defineJob({
  ...syncTickRef,
  async handler(ctx) {
    const now = new Date()
    let enqueued = 0
    for (const connection of await listConnectionsForTick(ctx)) {
      if (connection.health === 'auth_expired') continue
      const connector = ctx.connectors.get(connection.connectorId)
      if (!connector || !isChannel(connector)) continue
      for (const stream of dueStreams(connection.lastStartedAt, now)) {
        // A run of a missing capability records no start, so without this it would be enqueued every tick.
        if (!connector.capabilities[STREAM_CAPABILITIES[stream]]) continue
        await enqueueStream(ctx, stream, connection.organizationId, connection.id)
        enqueued++
      }
    }
    if (enqueued > 0) ctx.log.info('sync tick', { enqueued })
  },
})
