import { systemActor } from '../actor'
import type { Context } from '../context'
import { DomainError } from '../errors'
import { requestStockPush } from '../stock/push'
import { ensureDefaultWarehouse } from '../stock/warehouse'
import { TX_OPTIONS } from '../transaction'
import { linkLineInTx } from './link-line'
import { matchLines } from './match'

const MAX_LINES = 500

/** Matches Unmatched lines of new/processing Orders again (§2) and links them as the system. */
export async function rematchUnmatchedLines(ctx: Context, organizationId: string): Promise<{ linked: number }> {
  const lines = await ctx.db.orderLine.findMany({
    where: { organizationId, productId: null, order: { status: { in: ['new', 'processing'] } } },
    orderBy: [{ orderId: 'asc' }, { id: 'asc' }],
    take: MAX_LINES,
    select: { id: true, sku: true, offerExternalId: true, order: { select: { connectionId: true } } },
  })
  if (lines.length === 0) return { linked: 0 }
  await ensureDefaultWarehouse(ctx.db, organizationId)

  const byConnection = new Map<string, typeof lines>()
  for (const line of lines) {
    const group = byConnection.get(line.order.connectionId)
    if (group) group.push(line)
    else byConnection.set(line.order.connectionId, [line])
  }
  const candidates: Array<{ lineId: string; productId: string }> = []
  for (const [connectionId, group] of byConnection) {
    const productIds = await matchLines(ctx.db, organizationId, connectionId, group)
    group.forEach((line, index) => {
      const productId = productIds[index]
      if (productId) candidates.push({ lineId: line.id, productId })
    })
  }

  let linked = 0
  const connectionIds = new Set<string>()
  for (const candidate of candidates) {
    try {
      const result = await ctx.db.$transaction(
        (tx) => linkLineInTx(tx, organizationId, candidate.lineId, candidate.productId, systemActor, { openOrdersOnly: true }),
        TX_OPTIONS,
      )
      if (!result) continue
      linked++
      for (const connectionId of result.connectionIds) connectionIds.add(connectionId)
    } catch (error) {
      // Linked by someone else since the read above.
      if (error instanceof DomainError && error.code === 'already_linked') continue
      throw error
    }
  }
  await requestStockPush(ctx, organizationId, [...connectionIds])
  return { linked }
}
