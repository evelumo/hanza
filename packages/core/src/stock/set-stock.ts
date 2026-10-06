import type { Actor } from '../actor'
import type { Context } from '../context'
import { DomainError } from '../errors'
import { appendEvent } from '../events'
import { TX_OPTIONS } from '../transaction'
import { lockStock } from './locks'
import { markOffersForStockPush, requestStockPushAfterCommit } from './push'
import { ensureDefaultWarehouse } from './warehouse'

/**
 * Sets the absolute Stock of a Product in one Warehouse (the default Warehouse when none is given).
 * An inactive Warehouse is refused: it must stay empty (ADR 0017).
 */
export async function setStock(
  ctx: Context,
  organizationId: string,
  productId: string,
  units: number,
  actor: Actor,
  warehouseId?: string,
): Promise<void> {
  if (!Number.isInteger(units) || units < 0) throw new RangeError('Stock must be an integer >= 0')
  const defaultId = await ensureDefaultWarehouse(ctx.db, organizationId)
  const targetId = warehouseId ?? defaultId

  const connectionIds = await ctx.db.$transaction(async (tx) => {
    const product = await tx.product.findFirst({ where: { id: productId, organizationId }, select: { id: true } })
    if (!product) throw new DomainError('not_found')
    // The Warehouse is checked under its share lock, so it cannot be deactivated before this commits.
    const warehouse = (await lockStock(tx, organizationId, [productId])).find((locked) => locked.id === targetId)
    if (!warehouse) throw new DomainError('not_found')
    if (!warehouse.active) throw new DomainError('warehouse_inactive')

    const row = await tx.stock.findFirst({
      where: { organizationId, productId, warehouseId: targetId },
      select: { id: true, units: true },
    })
    if (!row) throw new Error(`Stock row missing for product ${productId} in warehouse ${targetId}`)
    if (row.units === units) return []

    await tx.stock.updateMany({ where: { id: row.id, organizationId }, data: { units } })
    await appendEvent(tx, {
      organizationId,
      type: 'stock.set',
      subject: { type: 'product', id: productId },
      payload: { warehouseId: targetId, from: row.units, to: units, actor },
    })
    return markOffersForStockPush(tx, organizationId, [productId])
  }, TX_OPTIONS)

  await requestStockPushAfterCommit(ctx, organizationId, connectionIds)
}
