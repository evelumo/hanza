import type { Actor } from '../actor'
import type { Context } from '../context'
import { DomainError } from '../errors'
import { appendEvent } from '../events'
import { TX_OPTIONS } from '../transaction'
import { lockStock } from './locks'
import { markOffersForStockPush, requestStockPushAfterCommit } from './push'
import { ensureDefaultWarehouse } from './warehouse'

/** Sets the absolute Stock of a Product in the default Warehouse. */
export async function setStock(ctx: Context, organizationId: string, productId: string, units: number, actor: Actor): Promise<void> {
  if (!Number.isInteger(units) || units < 0) throw new RangeError('Stock must be an integer >= 0')
  const warehouseId = await ensureDefaultWarehouse(ctx.db, organizationId)

  const connectionIds = await ctx.db.$transaction(async (tx) => {
    const product = await tx.product.findFirst({ where: { id: productId, organizationId }, select: { id: true } })
    if (!product) throw new DomainError('not_found')
    await lockStock(tx, organizationId, [productId])

    const row = await tx.stock.findFirst({ where: { organizationId, productId, warehouseId }, select: { id: true, units: true } })
    if (!row) throw new Error(`Stock row missing for product ${productId}`)
    if (row.units === units) return []

    await tx.stock.updateMany({ where: { id: row.id, organizationId }, data: { units } })
    await appendEvent(tx, {
      organizationId,
      type: 'stock.set',
      subject: { type: 'product', id: productId },
      payload: { warehouseId, from: row.units, to: units, actor },
    })
    return markOffersForStockPush(tx, organizationId, [productId])
  }, TX_OPTIONS)

  await requestStockPushAfterCommit(ctx, organizationId, connectionIds)
}
