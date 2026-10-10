import { isChannel, type AnyConnectorDefinition } from '@hanza/connector-sdk'
import { listConnectionsForTick } from '../connections/connections'
import { systemActor } from '../actor'
import { sweepSignIns } from '../connections/sign-in'
import type { Context } from '../context'
import { defineJob } from '../jobs'
import { claimDueDeletions, DELETION_SWEEP_LIMIT } from '../order-statuses/delete'
import { claimDueStatusPushes, STATUS_PUSH_SWEEP_LIMIT, STATUS_PUSH_SWEEP_LIMIT_FAILING } from '../orders/status-push'
import { claimDueShipmentCreates, hasDueShipmentChecks } from '../shipments/claims'
import { SHIPMENT_CREATE_SWEEP_LIMIT, SHIPMENT_CREATE_SWEEP_LIMIT_FAILING } from '../shipments/schedule'
import { dueStreams, STREAM_CAPABILITIES, type ScheduledStream } from '../sync/schedule'
import { workflowCoalesceKeys, workflowSweepRef } from '../workflows/refs'
import {
  coalesceKeys,
  offersPullRef,
  orderStatusesDeleteRef,
  ordersPullRef,
  ordersUpdateStatusRef,
  pricePushRef,
  shipmentsCreateRef,
  shipmentsTrackRef,
  stockPushRef,
  syncTickRef,
} from './refs'

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

type TickConnection = Awaited<ReturnType<typeof listConnectionsForTick>>[number]

/**
 * A Channel's part of the tick: every due stream its connector implements, and its overdue Order status pushes when
 * the connector has `orders.updateStatus` (ADR 0012).
 */
async function sweepChannel(ctx: Context, connection: TickConnection, connector: AnyConnectorDefinition, now: Date): Promise<{ enqueued: number; statusPushes: number }> {
  let enqueued = 0
  let statusPushes = 0
  for (const stream of dueStreams(connection.lastStartedAt, now)) {
    // A run of a missing capability records no start, so without this it would be enqueued every tick.
    if (!connector.capabilities[STREAM_CAPABILITIES[stream]]) continue
    await enqueueStream(ctx, stream, connection.organizationId, connection.id)
    enqueued++
  }
  if (!connector.capabilities['orders.updateStatus']) return { enqueued, statusPushes }
  const limit = connection.health === 'failing' ? STATUS_PUSH_SWEEP_LIMIT_FAILING : STATUS_PUSH_SWEEP_LIMIT
  for (const orderId of await claimDueStatusPushes(ctx, connection.organizationId, connection.id, limit)) {
    await ctx.queue.enqueue(
      ordersUpdateStatusRef,
      { organizationId: connection.organizationId, orderId },
      { coalesceKey: coalesceKeys.ordersUpdateStatus(orderId) },
    )
    statusPushes++
  }
  return { enqueued, statusPushes }
}

/**
 * The Shipments of a Connection whose connector follows them (ADR 0023): a `shipments.create` for each one still
 * waiting for its Carrier's answer and overdue, claimed like a status push, and one `shipments.track` when a Shipment
 * the Carrier knows is due (that job claims its own batch, since its payload names only the Connection).
 */
async function sweepShipments(ctx: Context, connection: TickConnection): Promise<{ creates: number; checks: number }> {
  const { organizationId, id: connectionId } = connection
  const limit = connection.health === 'failing' ? SHIPMENT_CREATE_SWEEP_LIMIT_FAILING : SHIPMENT_CREATE_SWEEP_LIMIT
  let creates = 0
  for (const shipmentId of await claimDueShipmentCreates(ctx, organizationId, connectionId, limit)) {
    await ctx.queue.enqueue(shipmentsCreateRef, { organizationId, shipmentId }, { coalesceKey: coalesceKeys.shipmentsCreate(shipmentId) })
    creates++
  }
  if (!(await hasDueShipmentChecks(ctx, organizationId, connectionId))) return { creates, checks: 0 }
  await ctx.queue.enqueue(shipmentsTrackRef, { organizationId, connectionId }, { coalesceKey: coalesceKeys.shipmentsTrack(connectionId) })
  return { creates, checks: 1 }
}

/**
 * One global scheduler: enqueues the workflow sweep (timers, signals, lost jobs; ADR 0014) and, for every Connection
 * not waiting for sign-in, what its connector is due: a Channel's streams and overdue Order status pushes
 * (`sweepChannel`), and the Shipments of a connector with `shipments.track`, whatever its kind (`sweepShipments`).
 * Also enqueues Order status deletions whose job was lost or keeps failing (ADR 0018), expires sign-ins left open
 * past their expiry and deletes ended ones after a day.
 */
export const syncTickJob = defineJob({
  ...syncTickRef,
  async handler(ctx) {
    await ctx.queue.enqueue(workflowSweepRef, {}, { coalesceKey: workflowCoalesceKeys.sweep })
    const now = new Date()
    let enqueued = 0
    let statusPushes = 0
    let shipmentCreates = 0
    let shipmentChecks = 0
    for (const connection of await listConnectionsForTick(ctx)) {
      if (connection.health === 'auth_expired') continue
      const connector = ctx.connectors.get(connection.connectorId)
      if (!connector) continue
      if (isChannel(connector)) {
        const swept = await sweepChannel(ctx, connection, connector, now)
        enqueued += swept.enqueued
        statusPushes += swept.statusPushes
      }
      if (connector.capabilities['shipments.track']) {
        const swept = await sweepShipments(ctx, connection)
        shipmentCreates += swept.creates
        shipmentChecks += swept.checks
      }
    }
    let deletions = 0
    for (const { organizationId, id: statusId } of await claimDueDeletions(ctx, DELETION_SWEEP_LIMIT)) {
      await ctx.queue.enqueue(
        orderStatusesDeleteRef,
        { organizationId, statusId, actor: systemActor },
        { coalesceKey: coalesceKeys.orderStatusesDelete(statusId) },
      )
      deletions++
    }
    const signIns = await sweepSignIns(ctx, now)
    const counts = { enqueued, statusPushes, shipmentCreates, shipmentChecks, deletions, signInsExpired: signIns.expired, signInsDeleted: signIns.deleted }
    if (Object.values(counts).some((count) => count > 0)) ctx.log.info('sync tick', counts)
  },
})
