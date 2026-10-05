import { isChannel } from '@hanza/connector-sdk'
import { listConnectionsForTick } from '../connections/connections'
import type { Context } from '../context'
import { defineJob } from '../jobs'
import { dueStreams, type ScheduledStream } from '../sync/schedule'
import { coalesceKeys, offersPullRef, ordersPullRef, stockPushRef, syncTickRef } from './refs'

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
  }
}

/** One global scheduler: enqueues every due stream of every Channel, except Connections waiting for sign-in. */
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
        await enqueueStream(ctx, stream, connection.organizationId, connection.id)
        enqueued++
      }
    }
    if (enqueued > 0) ctx.log.info('sync tick', { enqueued })
  },
})
