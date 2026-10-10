import type { AnyConnectorDefinition } from '@hanza/connector-sdk'
import type { Context } from '../context'

/**
 * A Channel's stock push waits until its Order feed has been read to its end once since the Connection was created or
 * the feed restarted (`caughtUpAt` of `orders_pull`, issue #125). Before that, the Orders open on the Channel are not
 * imported yet, so their Reservations are missing from Available and a push would offer units already sold there. A
 * connector without `orders.pull` (never a Channel) has no feed to wait for.
 */
export function isStockPushHeldBy(connector: AnyConnectorDefinition | undefined, ordersPull: { caughtUpAt: Date | null } | undefined): boolean {
  if (!connector?.capabilities['orders.pull']) return false
  return !ordersPull?.caughtUpAt
}

/** `isStockPushHeldBy` for one Connection; false for a Connection that is not in this organization (the run skips it). */
export async function isStockPushHeld(ctx: Context, organizationId: string, connectionId: string): Promise<boolean> {
  const connection = await ctx.db.connection.findFirst({
    where: { id: connectionId, organizationId },
    select: { connectorId: true, syncStates: { where: { organizationId, stream: 'orders_pull' }, select: { caughtUpAt: true } } },
  })
  if (!connection) return false
  return isStockPushHeldBy(ctx.connectors.get(connection.connectorId), connection.syncStates[0])
}
