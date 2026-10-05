import type { ChannelFact, Order } from '@hanza/connector-sdk'
import type { AttentionReason, Tx } from '@hanza/db'
import { systemActor } from '../actor'
import { normalizeSku } from '../catalog/sku'
import type { Context } from '../context'
import { DomainError } from '../errors'
import { appendEvent } from '../events'
import { sealBuyerData } from '../privacy/buyer-data'
import type { SecretBox } from '../secrets'
import { lockStock } from '../stock/locks'
import { markOffersForStockPush, requestStockPushAfterCommit } from '../stock/push'
import { reserveLine } from '../stock/reservations'
import { ensureDefaultWarehouse } from '../stock/warehouse'
import { TX_OPTIONS } from '../transaction'
import { matchLines } from './match'
import { addReasons, removeReasons } from './reasons'
import { factTransition, isFinalStatus } from './status-rules'
import { applyStockEffect } from './stock-effect'

/**
 * Imports one Order from a Channel (input already parsed with `orderSchema`).
 * An existing Order is a snapshot: only Channel facts not recorded yet change it.
 * Idempotent; a concurrent duplicate fails on the unique constraint and its retry takes the "exists" path.
 */
export async function importOrder(
  ctx: Context,
  organizationId: string,
  connectionId: string,
  order: Order,
): Promise<{ orderId: string; created: boolean; factsApplied: number }> {
  await ensureDefaultWarehouse(ctx.db, organizationId)

  const result = await ctx.db.$transaction(async (tx) => {
    const connection = await tx.connection.findFirst({ where: { id: connectionId, organizationId }, select: { id: true } })
    if (!connection) throw new DomainError('not_found')

    const existing = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "order"
      WHERE "connectionId" = ${connectionId} AND "externalId" = ${order.externalId} AND "organizationId" = ${organizationId}
      FOR NO KEY UPDATE`
    const touched = new Set<string>()
    const orderId = existing[0]?.id ?? (await insertOrder(tx, ctx.secrets, organizationId, connectionId, order, touched))
    const factsApplied = await applyNewFacts(tx, organizationId, orderId, order.facts, touched)
    const connectionIds = await markOffersForStockPush(tx, organizationId, [...touched])
    return { orderId, created: existing.length === 0, factsApplied, connectionIds }
  }, TX_OPTIONS)

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
  const created = await tx.order.create({
    data: {
      organizationId,
      connectionId,
      externalId: order.externalId,
      placedAt: new Date(order.placedAt),
      payment: order.payment,
      currency: order.total.currency,
      totalAmount: order.total.amount,
      // Buyer data never reaches the database in plaintext (ADR 0011).
      ...sealBuyerData(
        secrets,
        { organizationId, connectionId, externalId: order.externalId },
        { buyer: order.buyer, shippingAddress: order.shippingAddress, billingAddress: order.billingAddress },
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
      { orderId: created.id, orderLineId: line.id, productId: line.productId, units: line.quantity },
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

/** Records Channel facts not seen before, in (occurredAt, id) order, applying each through `factTransition`. Caller holds the Order lock. */
async function applyNewFacts(tx: Tx, organizationId: string, orderId: string, facts: ChannelFact[], touched: Set<string>): Promise<number> {
  if (facts.length === 0) return 0
  const recorded = await tx.orderChannelFact.findMany({ where: { organizationId, orderId }, select: { externalId: true } })
  const seen = new Set(recorded.map((fact) => fact.externalId))
  const fresh = [...new Map(facts.filter((fact) => !seen.has(fact.id)).map((fact) => [fact.id, fact])).values()].sort(
    (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || compare(a.id, b.id),
  )
  if (fresh.length === 0) return 0

  const order = await tx.order.findFirst({
    where: { id: orderId, organizationId },
    select: { status: true, attentionReasons: true, buyerDataErasedAt: true },
  })
  if (!order) throw new DomainError('not_found')
  let { status, attentionReasons: reasons } = order
  const statusBefore = status
  const subject = { type: 'order', id: orderId } as const

  for (const fact of fresh) {
    await tx.orderChannelFact.create({
      // A note may quote the Buyer; once the Order's Buyer data is erased, it must not come back (ADR 0011).
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

    const transition = factTransition(status, fact.type)
    if (transition.to) {
      for (const productId of await applyStockEffect(tx, organizationId, orderId, transition.to)) touched.add(productId)
      await appendEvent(tx, {
        organizationId,
        type: 'order.status_changed',
        subject,
        payload: { from: status, to: transition.to, cause: 'channel_fact', factId: fact.id, actor: systemActor },
      })
      status = transition.to
      if (status === 'cancelled') reasons = removeReasons(reasons, ['shortage'])
    }
    if (transition.reason) {
      const next = addReasons(reasons, [transition.reason])
      reasons = next.reasons
      if (next.added.length > 0) {
        await appendEvent(tx, { organizationId, type: 'order.attention_raised', subject, payload: { reasons: next.added } })
      }
    }
  }

  const closed = status !== statusBefore && isFinalStatus(status)
  await tx.order.updateMany({
    where: { id: orderId, organizationId },
    data: { status, attentionReasons: reasons, ...(closed ? { closedAt: new Date() } : {}) },
  })
  return fresh.length
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
