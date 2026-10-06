import { isChannel } from '@hanza/connector-sdk'
import type { Actor } from '../actor'
import type { Context } from '../context'
import { DomainError } from '../errors'
import { appendEvent } from '../events'
import { markConnectionOffersForStockPush, requestStockPushAfterCommit } from '../stock/push'
import { TX_OPTIONS } from '../transaction'

/** Which Warehouses a Channel counts: every active one (including ones added later), or these. */
export type ChannelWarehouseChoice = { all: true } | { all: false; warehouseIds: string[] }

/**
 * Sets which Warehouses count for a Channel Connection (any other Connection is `not_a_channel`). An
 * explicit choice needs at least one Warehouse, all of them active. Locks, in this order (ADR 0017):
 * the Connection row, the organization's Warehouse rows FOR SHARE by id (so none of them can be
 * deactivated or deleted meanwhile), its choice rows, then its linked Offers by id, whose push
 * sequence is bumped so the Channel is told its new number even if the enqueue is lost (ADR 0010).
 */
export async function updateChannelWarehouses(
  ctx: Context,
  organizationId: string,
  connectionId: string,
  choice: ChannelWarehouseChoice,
  actor: Actor,
): Promise<void> {
  const chosen = choice.all ? [] : [...new Set(choice.warehouseIds)].sort()
  if (!choice.all && chosen.length === 0) throw new DomainError('no_warehouse_selected')

  const changed = await ctx.db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ connectorId: string; allWarehouses: boolean }>>`
      SELECT "connectorId", "allWarehouses" FROM "connection"
      WHERE "id" = ${connectionId} AND "organizationId" = ${organizationId}
      FOR NO KEY UPDATE`
    const connection = rows[0]
    if (!connection) throw new DomainError('not_found')
    const connector = ctx.connectors.get(connection.connectorId)
    if (!connector || !isChannel(connector)) throw new DomainError('not_a_channel')

    const warehouses = await tx.$queryRaw<Array<{ id: string; active: boolean }>>`
      SELECT "id", "active" FROM "warehouse"
      WHERE "organizationId" = ${organizationId}
      ORDER BY "id"
      FOR SHARE`
    const byId = new Map(warehouses.map((warehouse) => [warehouse.id, warehouse]))
    for (const id of chosen) {
      const warehouse = byId.get(id)
      if (!warehouse) throw new DomainError('not_found')
      if (!warehouse.active) throw new DomainError('warehouse_inactive')
    }

    const current = await tx.connectionWarehouse.findMany({
      where: { organizationId, connectionId },
      orderBy: { warehouseId: 'asc' },
      select: { warehouseId: true },
    })
    const from = connection.allWarehouses
      ? { all: true, warehouseIds: [] as string[] }
      : { all: false, warehouseIds: current.map((row) => row.warehouseId) }
    const to = { all: choice.all, warehouseIds: chosen }
    if (from.all === to.all && from.warehouseIds.join() === to.warehouseIds.join()) return false

    await tx.connection.updateMany({ where: { id: connectionId, organizationId }, data: { allWarehouses: choice.all } })
    await tx.connectionWarehouse.deleteMany({ where: { organizationId, connectionId } })
    if (chosen.length > 0) {
      await tx.connectionWarehouse.createMany({ data: chosen.map((warehouseId) => ({ organizationId, connectionId, warehouseId })) })
    }
    await markConnectionOffersForStockPush(tx, organizationId, connectionId)
    await appendEvent(tx, {
      organizationId,
      type: 'connection.warehouses_changed',
      subject: { type: 'connection', id: connectionId },
      payload: { from, to, actor },
    })
    return true
  }, TX_OPTIONS)

  if (changed) await requestStockPushAfterCommit(ctx, organizationId, [connectionId])
}
