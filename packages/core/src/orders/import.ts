import type { ChannelFact, Order } from '@hanza/connector-sdk'
import type { AttentionReason, Tx } from '@hanza/db'
import { systemActor } from '../actor'
import { normalizeSku } from '../catalog/sku'
import type { Context } from '../context'
import { DomainError } from '../errors'
import { appendEvent } from '../events'
import { ensureDefaultOrderStatuses, resolveStatusForPhase } from '../order-statuses/defaults'
import { sealBuyerData } from '../privacy/buyer-data'
import type { SecretBox } from '../secrets'
import { lockStock } from '../stock/locks'
import { markOffersForStockPush, requestStockPushAfterCommit } from '../stock/push'
import { reserveLine } from '../stock/reservations'
import { ensureDefaultWarehouse } from '../stock/warehouse'
import { TX_OPTIONS } from '../transaction'
import { matchLines } from './match'
import { addReasons, reasonsAfterCancel } from './reasons'
import { factTransition, isFinalPhase } from './status-rules'
import { applyStockEffect } from './stock-effect'

/**
 * Imports one Order from a Channel (input already parsed with `orderSchema`). An Order awaiting payment
 * reserves like any other (ADR 0015). An existing Order is a snapshot: only Channel facts not recorded yet
 * change it, so a later `awaitingPayment: false` means nothing without a `paid` fact.
 * Idempotent; a concurrent duplicate fails on the unique constraint and its retry takes the "exists" path.
 */
export async function importOrder(
  ctx: Context,
  organizationId: string,
  connectionId: string,
  order: Order,
): Promise<{ orderId: string; created: boolean; factsApplied: number }> {
  await ensureDefaultWarehouse(ctx.db, organizationId)
  await ensureDefaultOrderStatuses(ctx.db, organizationId)

  const result = await ctx.db.$transaction(async (tx) => {
    const connection = await tx.connection.findFirst({ where: { id: connectionId, organizationId }, select: { id: true } })
    if (!connection) throw new DomainError('not_found')

    const existing = await tx.$queryRaw<Array<{ id: string; awaitingPayment: boolean }>>`
      SELECT "id", "awaitingPayment" FROM "order"
      WHERE "connectionId" = ${connectionId} AND "externalId" = ${order.externalId} AND "organizationId" = ${organizationId}
      FOR NO KEY UPDATE`
    const touched = new Set<string>()
    const orderId = existing[0]?.id ?? (await insertOrder(tx, ctx.secrets, organizationId, connectionId, order, touched))
    const factsApplied = await applyNewFacts(tx, organizationId, connectionId, orderId, order.facts, touched)
    const connectionIds = await markOffersForStockPush(tx, organizationId, [...touched])
    return { orderId, created: existing.length === 0, wasAwaitingPayment: existing[0]?.awaitingPayment === true, factsApplied, connectionIds }
  }, TX_OPTIONS)

  if (result.wasAwaitingPayment && droppedPaymentFlagWithoutFact(order)) {
    // Ids only: the snapshot holds Buyer data.
    ctx.log.warn('Order no longer awaiting payment on the Channel but no paid fact was reported; it stays awaiting payment', {
      connectionId,
      externalId: order.externalId,
    })
  }
  await requestStockPushAfterCommit(ctx, organizationId, result.connectionIds)
  return { orderId: result.orderId, created: result.created, factsApplied: result.factsApplied }
}

async function insertOrder(
  tx: Tx,
  secrets: SecretBox,
  organizationId: string,
  connectionId: string,
  order: Order,
  touched: Set<string>,
): Promise<string> {
  const productIds = await matchLines(tx, organizationId, connectionId, order.lines)
  const status = await resolveStatusForPhase(tx, organizationId, connectionId, 'new')
  const created = await tx.order.create({
    data: {
      organizationId,
      connectionId,
      externalId: order.externalId,
      phase: 'new',
      statusId: status.id,
      placedAt: new Date(order.placedAt),
      payment: order.payment,
      awaitingPayment: order.awaitingPayment === true,
      currency: order.total.currency,
      totalAmount: order.total.amount,
      // Buyer data never reaches the database in plaintext (ADR 0016).
      ...sealBuyerData(
        secrets,
        { organizationId, connectionId, externalId: order.externalId },
        {
          buyer: order.buyer,
          shippingAddress: order.shippingAddress,
          billingAddress: order.billingAddress,
          ...(order.delivery === undefined ? {} : { delivery: order.delivery }),
        },
      ),
      lines: {
        create: order.lines.map((line, index) => ({
          organizationId,
          externalId: line.externalId,
          offerExternalId: line.offerExternalId,
          sku: normalizeSku(line.sku),
          name: line.name,
          quantity: line.quantity,
          unitPriceAmount: line.unitPrice.amount,
          productId: productIds[index] ?? null,
        })),
      },
    },
    select: { id: true, lines: { select: { id: true, productId: true, quantity: true, externalId: true } } },
  })

  const matched = created.lines
    .filter((line): line is typeof line & { productId: string } => line.productId !== null)
    .sort((a, b) => compare(a.productId, b.productId) || compare(a.externalId, b.externalId))
  await lockStock(tx, organizationId, matched.map((line) => line.productId))

  const shortageLines: string[] = []
  for (const line of matched) {
    // Re-reading Available per line covers several lines of one Product: each sees the previous Reservation.
    const { shortage } = await reserveLine(
      tx,
      organizationId,
      { orderId: created.id, orderLineId: line.id, connectionId, productId: line.productId, units: line.quantity },
      'open',
    )
    touched.add(line.productId)
    if (shortage) shortageLines.push(line.id)
  }
  if (shortageLines.length > 0) {
    await tx.orderLine.updateMany({ where: { organizationId, id: { in: shortageLines } }, data: { shortage: true } })
  }

  const unmatchedLines = created.lines.length - matched.length
  const reasons: AttentionReason[] = []
  if (unmatchedLines > 0) reasons.push('unmatched_line')
  if (shortageLines.length > 0) reasons.push('shortage')
  if (reasons.length > 0) {
    await tx.order.updateMany({ where: { id: created.id, organizationId }, data: { attentionReasons: reasons } })
  }

  await appendEvent(tx, {
    organizationId,
    type: 'order.imported',
    subject: { type: 'order', id: created.id },
    payload: {
      connectionId,
      externalId: order.externalId,
      awaitingPayment: order.awaitingPayment === true,
      lineCount: created.lines.length,
      unmatchedLines,
      shortageLines: shortageLines.length,
    },
  })
  if (reasons.length > 0) {
    await appendEvent(tx, { organizationId, type: 'order.attention_raised', subject: { type: 'order', id: created.id }, payload: { reasons } })
  }
  return created.id
}

/**
 * Records Channel facts not seen before, in (occurredAt, id) order, applying each through `factTransition`. A fact that
 * moves the phase puts the Order in the Connection's mapped status for that phase, else its default. Caller holds the Order lock.
 */
export async function applyNewFacts(
  tx: Tx,
  organizationId: string,
  connectionId: string,
  orderId: string,
  facts: ChannelFact[],
  touched: Set<string>,
): Promise<number> {
  if (facts.length === 0) return 0
  const recorded = await tx.orderChannelFact.findMany({ where: { organizationId, orderId }, select: { externalId: true } })
  const seen = new Set(recorded.map((fact) => fact.externalId))
  const fresh = [...new Map(facts.filter((fact) => !seen.has(fact.id)).map((fact) => [fact.id, fact])).values()].sort(
    (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || compare(a.id, b.id),
  )
  if (fresh.length === 0) return 0

  const order = await tx.order.findFirst({
    where: { id: orderId, organizationId },
    select: {
      phase: true,
      attentionReasons: true,
      awaitingPayment: true,
      buyerDataErasedAt: true,
      status: { select: { id: true, name: true, phase: true } },
    },
  })
  if (!order) throw new DomainError('not_found')
  let { phase, status, attentionReasons: reasons, awaitingPayment } = order
  const before = phase
  const subject = { type: 'order', id: orderId } as const

  for (const fact of fresh) {
    await tx.orderChannelFact.create({
      // A note may quote the Buyer; once the Order's Buyer data is erased, it must not come back (ADR 0016).
      data: {
        organizationId,
        orderId,
        externalId: fact.id,
        type: fact.type,
        occurredAt: new Date(fact.occurredAt),
        note: order.buyerDataErasedAt === null ? fact.note : null,
      },
    })
    await appendEvent(tx, {
      organizationId,
      type: 'order.channel_fact_recorded',
      subject,
      payload: { factId: fact.id, type: fact.type, occurredAt: fact.occurredAt },
    })

    const transition = factTransition(phase, fact.type, awaitingPayment)
    if (transition.paid) {
      // Its Reservations were made at import, so payment touches no Stock: from here on it is a ready Order.
      awaitingPayment = false
      await appendEvent(tx, { organizationId, type: 'order.payment_received', subject, payload: { factId: fact.id } })
    }
    if (transition.to) {
      for (const productId of await applyStockEffect(tx, organizationId, orderId, transition.to)) touched.add(productId)
      const next = await resolveStatusForPhase(tx, organizationId, connectionId, transition.to)
      await appendEvent(tx, {
        organizationId,
        type: 'order.status_changed',
        subject,
        payload: { from: phase, to: transition.to, fromStatus: status, toStatus: next, cause: 'channel_fact', factId: fact.id, actor: systemActor },
      })
      phase = transition.to
      status = next
      if (phase === 'cancelled') reasons = reasonsAfterCancel(reasons)
    }
    if (transition.reason) {
      const next = addReasons(reasons, [transition.reason])
      reasons = next.reasons
      if (next.added.length > 0) {
        await appendEvent(tx, { organizationId, type: 'order.attention_raised', subject, payload: { reasons: next.added } })
      }
    }
  }

  // The Channel's own fact is newer than any status still waiting to be pushed, and is never pushed back (ADR 0003).
  // A `paid` fact changes no phase, so it leaves a pending push alone. Only a change of phase starts the retention
  // clock: facts never move an Order within a phase, and a final phase is never left.
  const phaseChanged = phase !== before
  const statusPush = phaseChanged ? { statusPushDueAt: null } : {}
  const closed = phaseChanged && isFinalPhase(phase)
  await tx.order.updateMany({
    where: { id: orderId, organizationId },
    data: {
      phase,
      statusId: status.id,
      attentionReasons: reasons,
      awaitingPayment,
      ...statusPush,
      ...(closed ? { closedAt: new Date() } : {}),
    },
  })
  return fresh.length
}

/**
 * A connector broke the contract (ADR 0015): the snapshot says the Order is no longer awaiting payment but
 * carries no `paid` fact. A `cancelled` fact explains it; a connector that never sends the flag never stores it.
 */
function droppedPaymentFlagWithoutFact(order: Order): boolean {
  return order.awaitingPayment !== true && !order.facts.some((fact) => fact.type === 'paid' || fact.type === 'cancelled')
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
