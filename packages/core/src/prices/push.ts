import type { Money } from '@hanza/connector-sdk'
import type { Tx } from '@hanza/db'
import { afterCommit } from '../after-commit'
import type { Context } from '../context'
import { appendEvent } from '../events'
import { coalesceKeys, pricePushRef } from '../jobs/refs'
import { TX_OPTIONS } from '../transaction'
import { effectivePrice, moneyFromColumns } from './price'

/**
 * Bumps `pricePushSeq` of every Offer linked to these Products, in the transaction that changed their
 * base price. Rows are locked in id order, like `markOffersForStockPush`, so the two cannot deadlock.
 */
export async function markOffersForPricePush(tx: Tx, organizationId: string, productIds: string[]): Promise<string[]> {
  const ids = [...new Set(productIds)]
  if (ids.length === 0) return []
  const rows = await tx.$queryRaw<Array<{ connectionId: string }>>`
    UPDATE "offer" SET "pricePushSeq" = "pricePushSeq" + 1, "updatedAt" = now()
    WHERE "id" IN (
      SELECT "id" FROM "offer"
      WHERE "organizationId" = ${organizationId} AND "productId" = ANY(${ids}::text[])
      ORDER BY "id"
      FOR UPDATE)
    RETURNING "connectionId"`
  return [...new Set(rows.map((row) => row.connectionId))]
}

/** Enqueues a coalesced `price.push` per Connection. */
export async function requestPricePush(ctx: Context, organizationId: string, connectionIds: string[]): Promise<void> {
  for (const connectionId of new Set(connectionIds)) {
    await ctx.queue.enqueue(pricePushRef, { organizationId, connectionId }, { coalesceKey: coalesceKeys.pricePush(connectionId) })
  }
}

/**
 * `requestPricePush` right after a commit: a failed enqueue is logged and never fails the operation,
 * because the tick's 10-minute sweep pushes every Offer whose price push sequence is still ahead (ADR 0010).
 */
export async function requestPricePushAfterCommit(ctx: Context, organizationId: string, connectionIds: string[]): Promise<void> {
  for (const connectionId of new Set(connectionIds)) {
    await afterCommit(ctx, { job: pricePushRef.name, organizationId, connectionId }, () => requestPricePush(ctx, organizationId, [connectionId]))
  }
}

export interface OfferAwaitingPricePush {
  offerId: string
  externalId: string
  sku: string | null
  seq: number
  effective: Money | null
  channelCurrency: string | null
}

/** Linked Offers whose price push sequence is ahead of the last handled one, by id, with their effective price. */
export async function listOffersAwaitingPricePush(
  ctx: Context,
  organizationId: string,
  connectionId: string,
  limit: number,
): Promise<OfferAwaitingPricePush[]> {
  const offers = await ctx.db.offer.findMany({
    where: { organizationId, connectionId, productId: { not: null }, pricePushSeq: { gt: ctx.db.offer.fields.pricePushedSeq } },
    orderBy: { id: 'asc' },
    take: limit,
    select: {
      id: true,
      externalId: true,
      sku: true,
      pricePushSeq: true,
      priceOverrideAmount: true,
      priceOverrideCurrency: true,
      channelPriceCurrency: true,
      product: { select: { basePriceAmount: true, basePriceCurrency: true } },
    },
  })
  return offers.map((offer) => ({
    offerId: offer.id,
    externalId: offer.externalId,
    sku: offer.sku,
    seq: offer.pricePushSeq,
    effective: effectivePrice(
      moneyFromColumns(offer.priceOverrideAmount, offer.priceOverrideCurrency),
      offer.product ? moneyFromColumns(offer.product.basePriceAmount, offer.product.basePriceCurrency) : null,
    ),
    channelCurrency: offer.channelPriceCurrency,
  }))
}

/**
 * Compare-and-clear, like `recordStockPushOutcomes`: records `seq` as handled only if it is still ahead, so a change
 * made after the list was read keeps the Offer pending. `pushed` null = skipped (nothing that could be sent).
 * `rejected` = the Channel refused this Offer's price: the code is kept with an Event and the Offer counts as
 * handled; a later push or skip clears it.
 */
export async function markOffersPriceHandled(
  ctx: Context,
  organizationId: string,
  handled: Array<{ offerId: string; seq: number; pushed: Money | null; rejected?: string }>,
): Promise<void> {
  if (handled.length === 0) return
  const sorted = [...handled].sort((a, b) => (a.offerId < b.offerId ? -1 : a.offerId > b.offerId ? 1 : 0))
  await ctx.db.$transaction(async (tx) => {
    const now = new Date()
    for (const item of sorted) {
      const where = { id: item.offerId, organizationId, pricePushedSeq: { lt: item.seq } }
      if (item.rejected !== undefined) {
        const { count } = await tx.offer.updateMany({
          where,
          data: { pricePushedSeq: item.seq, priceRejectedCode: item.rejected, priceRejectedAt: now },
        })
        if (count > 0) {
          await appendEvent(tx, {
            organizationId,
            type: 'offer.push_rejected',
            subject: { type: 'offer', id: item.offerId },
            payload: { push: 'price', code: item.rejected },
          })
        }
        continue
      }
      await tx.offer.updateMany({
        where,
        data: {
          pricePushedSeq: item.seq,
          priceRejectedCode: null,
          priceRejectedAt: null,
          ...(item.pushed
            ? { lastPushedPriceAmount: item.pushed.amount, lastPushedPriceCurrency: item.pushed.currency, lastPricePushedAt: now }
            : {}),
        },
      })
    }
  }, TX_OPTIONS)
}
