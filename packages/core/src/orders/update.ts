import type { OrderUpdate } from '@hanza/connector-sdk'
import type { Context } from '../context'
import { DomainError } from '../errors'
import { appendEvent } from '../events'
import { replaceBuyerAddresses, type AddressReplacement } from '../privacy/addresses'
import { markOffersForStockPush, orderOffers, requestStockPushAfterCommit } from '../stock/push'
import { TX_OPTIONS } from '../transaction'
import { applyNewFacts } from './import'
import type { OrderPhase } from './phases'

export type OrderUpdateResult =
  /** Hanza has no such Order on this Connection, e.g. one that closed before the Connection: ignored. */
  | { found: false }
  | { found: true; orderId: string; factsApplied: number; addresses: AddressReplacement['result'] | 'not_new' | 'none' }

/**
 * Applies an Order update (input already parsed with `orderUpdateSchema`) to an Order this Connection imported before.
 * Facts take the same path as the facts of a full Order (ADR 0003, ADR 0015). Addresses replace the stored ones only
 * while the Order is still in phase new after those facts: later, a person may already be packing it for the old
 * address. Idempotent: a fact is recorded once per id, and an address equal to the stored one writes nothing.
 */
export async function applyOrderUpdate(
  ctx: Context,
  organizationId: string,
  connectionId: string,
  update: OrderUpdate,
): Promise<OrderUpdateResult> {
  const result = await ctx.db.$transaction(async (tx) => {
    const connection = await tx.connection.findFirst({ where: { id: connectionId, organizationId }, select: { id: true } })
    if (!connection) throw new DomainError('not_found')

    const rows = await tx.$queryRaw<Array<{ id: string; phase: OrderPhase }>>`
      SELECT "id", "phase" FROM "order"
      WHERE "connectionId" = ${connectionId} AND "externalId" = ${update.externalId} AND "organizationId" = ${organizationId}
      FOR NO KEY UPDATE`
    const order = rows[0]
    if (!order) return null

    // Facts first: an update that cancels or ships the Order leaves its addresses alone.
    const touched = new Set<string>()
    const factsApplied = await applyNewFacts(tx, organizationId, connectionId, order.id, update.facts, touched)
    // A new fact marks the Order's Offers on this Connection even when it moved no Stock (ADR 0023).
    const reassert = factsApplied > 0 ? await orderOffers(tx, organizationId, order.id) : null
    const connectionIds = await markOffersForStockPush(tx, organizationId, [...touched], reassert)

    let addresses: Extract<OrderUpdateResult, { found: true }>['addresses'] = 'none'
    if (update.shippingAddress !== undefined || update.billingAddress !== undefined) {
      const phase = factsApplied === 0 ? order.phase : (await tx.order.findFirstOrThrow({ where: { id: order.id, organizationId }, select: { phase: true } })).phase
      if (phase !== 'new') {
        addresses = 'not_new'
      } else {
        const change = { shippingAddress: update.shippingAddress, billingAddress: update.billingAddress }
        const replaced = await replaceBuyerAddresses(tx, ctx.secrets, organizationId, order.id, change)
        addresses = replaced.result
        if (replaced.result === 'replaced') {
          await appendEvent(tx, {
            organizationId,
            type: 'order.addresses_updated',
            subject: { type: 'order', id: order.id },
            // Which address changed, never what it says (ADR 0016).
            payload: { shippingAddress: replaced.shippingAddress, billingAddress: replaced.billingAddress },
          })
        }
      }
    }
    return { orderId: order.id, factsApplied, addresses, connectionIds }
  }, TX_OPTIONS)

  if (!result) return { found: false }
  if (result.addresses === 'not_new' || result.addresses === 'unreadable') {
    // Ids only: the addresses are Buyer data.
    ctx.log.warn('Order update: addresses not replaced', { connectionId, orderId: result.orderId, reason: result.addresses })
  }
  await requestStockPushAfterCommit(ctx, organizationId, result.connectionIds)
  return { found: true, orderId: result.orderId, factsApplied: result.factsApplied, addresses: result.addresses }
}
