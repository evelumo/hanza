import { isChannel } from '@hanza/connector-sdk'
import type { Actor } from '../actor'
import type { Context } from '../context'
import { DomainError } from '../errors'
import { appendEvent } from '../events'
import { channelStockRulesSchema, type ChannelStockRules } from '../stock/channel-available'
import { markConnectionOffersForStockPush, requestStockPushAfterCommit } from '../stock/push'
import { TX_OPTIONS } from '../transaction'

/**
 * Sets a Channel Connection's Safety buffer and Channel limit; any other Connection is `not_a_channel`. Every linked Offer of the Connection is
 * marked for a stock push in the same transaction, so its Channel is told the new Channel
 * Available even if the enqueue after commit is lost (ADR 0010). Touches no Stock or
 * Reservation row, so the ADR 0004 lock order is not involved: Connection row, then Offers by id.
 */
export async function updateChannelStockRules(
  ctx: Context,
  organizationId: string,
  connectionId: string,
  rules: ChannelStockRules,
  actor: Actor,
): Promise<void> {
  const parsed = channelStockRulesSchema.safeParse(rules)
  if (!parsed.success) throw new RangeError('Safety buffer and Channel limit must be whole numbers from 0 to 1,000,000')
  const to = parsed.data

  const changed = await ctx.db.$transaction(async (tx) => {
    // NO KEY UPDATE, like `setHealth`: it serialises edits of this row without waiting for Offer
    // and Order inserts, whose foreign keys only take KEY SHARE locks on the Connection.
    const rows = await tx.$queryRaw<Array<ChannelStockRules & { connectorId: string }>>`
      SELECT "connectorId", "safetyBuffer", "channelLimit" FROM "connection"
      WHERE "id" = ${connectionId} AND "organizationId" = ${organizationId}
      FOR NO KEY UPDATE`
    const from = rows[0]
    if (!from) throw new DomainError('not_found')
    // The same test as the panel uses to show the form: only a Channel is told stock.
    const connector = ctx.connectors.get(from.connectorId)
    if (!connector || !isChannel(connector)) throw new DomainError('not_a_channel')
    if (from.safetyBuffer === to.safetyBuffer && from.channelLimit === to.channelLimit) return false

    await tx.connection.updateMany({ where: { id: connectionId, organizationId }, data: to })
    await markConnectionOffersForStockPush(tx, organizationId, connectionId)
    await appendEvent(tx, {
      organizationId,
      type: 'connection.stock_rules_changed',
      subject: { type: 'connection', id: connectionId },
      payload: { from: { safetyBuffer: from.safetyBuffer, channelLimit: from.channelLimit }, to, actor },
    })
    return true
  }, TX_OPTIONS)

  if (changed) await requestStockPushAfterCommit(ctx, organizationId, [connectionId])
}
