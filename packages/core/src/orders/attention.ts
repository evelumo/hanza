import type { Actor } from '../actor'
import type { Context } from '../context'
import { DomainError } from '../errors'
import { appendEvent } from '../events'
import { lockOrder } from '../stock/locks'
import { TX_OPTIONS } from '../transaction'

/** A person marks the Order as checked: every reason except `unmatched_line` (which is automatic) is cleared. */
export async function resolveAttention(ctx: Context, organizationId: string, orderId: string, actor: Actor): Promise<void> {
  await ctx.db.$transaction(async (tx) => {
    if (!(await lockOrder(tx, organizationId, orderId))) throw new DomainError('not_found')
    const order = await tx.order.findFirst({ where: { id: orderId, organizationId }, select: { attentionReasons: true } })
    if (!order) throw new DomainError('not_found')
    const cleared = order.attentionReasons.filter((reason) => reason !== 'unmatched_line')
    if (cleared.length === 0) return
    await tx.order.updateMany({
      where: { id: orderId, organizationId },
      data: { attentionReasons: order.attentionReasons.filter((reason) => reason === 'unmatched_line') },
    })
    await appendEvent(tx, {
      organizationId,
      type: 'order.attention_resolved',
      subject: { type: 'order', id: orderId },
      payload: { cleared, actor },
    })
  }, TX_OPTIONS)
}
