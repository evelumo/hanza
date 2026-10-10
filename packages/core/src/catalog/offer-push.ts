import type { OfferEndedReason, OfferPublicationStatus } from '@hanza/connector-sdk'
import type { Tx } from '@hanza/db'
import type { Actor } from '../actor'
import type { Context } from '../context'
import { DomainError } from '../errors'
import { appendEvent } from '../events'
import { requestPricePushAfterCommit } from '../prices/push'
import { requestStockPushAfterCommit } from '../stock/push'
import { TX_OPTIONS } from '../transaction'

/** The rejection Hanza records itself, without calling the Channel, for an ended Offer it must not reopen (ADR 0022). */
export const OFFER_ENDED_CODE = 'offer_ended'

export type PushKind = 'stock' | 'price'

/** An Offer's publication on its Channel; null when the Channel never said. */
export interface OfferPublication {
  status: OfferPublicationStatus
  /** Only for `ended`; null when the Channel did not say why. */
  endedReason: OfferEndedReason | null
}

export function publicationFromColumns(status: OfferPublicationStatus | null, endedReason: OfferEndedReason | null): OfferPublication | null {
  return status === null ? null : { status, endedReason: status === 'ended' ? endedReason : null }
}

export type StockPushDecision = 'push' | 'skip' | 'reject'

/**
 * What the stock push does with one Offer (ADR 0022). Hanza always sends the real number, 0 included, except to an
 * Offer the Channel reports ended: 0 changes nothing there (skip), and a number above 0 is sent only to an Offer that
 * ended because it sold out, through a connector that reopens such Offers; any other ended Offer is rejected
 * without a call. Inactive and unknown Offers are pushed like active ones.
 *
 * `available` is null when the Offer's Product has unset Stock (no Stock row, #137): Hanza does not know the number
 * yet, so the Offer is left out (skip) instead of being told 0, which would end it on most marketplaces.
 */
export function decideStockPush(
  available: number | null,
  publication: OfferPublication | null,
  reopensSoldOutOffers: boolean,
): StockPushDecision {
  if (available === null) return 'skip'
  if (publication?.status !== 'ended') return 'push'
  if (available === 0) return 'skip'
  return publication.endedReason === 'sold_out' && reopensSoldOutOffers ? 'push' : 'reject'
}

/** A push's record on an Offer: the code the Channel refused it with, if it was not superseded by a later push. */
export interface PushRejection {
  code: string
  at: Date
}

/** The rejection is shown only while nothing newer is waiting: once the sequence moves, the Offer is "waiting to be sent" again. */
export function currentRejection(code: string | null, at: Date | null, awaitingPush: boolean): PushRejection | null {
  return code !== null && at !== null && !awaitingPush ? { code, at } : null
}

/**
 * Stores a publication the Channel reported (a pull or a push result) and records the change as an Event. Locks the
 * Offer row; callers lock Offers in id order (ADR 0017, step 4). Returns whether it changed.
 */
export async function setOfferPublication(
  tx: Tx,
  organizationId: string,
  offerId: string,
  to: OfferPublication,
  source: 'pull' | 'push',
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ channelStatus: OfferPublicationStatus | null; channelEndedReason: OfferEndedReason | null }>>`
    SELECT "channelStatus", "channelEndedReason" FROM "offer"
    WHERE "id" = ${offerId} AND "organizationId" = ${organizationId}
    FOR NO KEY UPDATE`
  const row = rows[0]
  if (!row) return false
  const endedReason = to.status === 'ended' ? to.endedReason : null
  if (row.channelStatus === to.status && row.channelEndedReason === endedReason) return false
  await tx.offer.updateMany({
    where: { id: offerId, organizationId },
    data: { channelStatus: to.status, channelEndedReason: endedReason },
  })
  await appendEvent(tx, {
    organizationId,
    type: 'offer.channel_status_changed',
    subject: { type: 'offer', id: offerId },
    payload: { from: row.channelStatus, to: to.status, endedReason, source },
  })
  return true
}

/**
 * "Retry" on a rejected push: moves the Offer's stock or price push sequence so the next push sends it again, and
 * requests that push. Any other change that moves the sequence (Stock, rules, price, link) retries it the same way.
 */
export async function retryOfferPush(ctx: Context, organizationId: string, offerId: string, push: PushKind, actor: Actor): Promise<void> {
  const connectionId = await ctx.db.$transaction(async (tx) => {
    const offer = await tx.offer.findFirst({ where: { id: offerId, organizationId }, select: { connectionId: true, productId: true } })
    if (!offer) throw new DomainError('not_found')
    if (!offer.productId) throw new DomainError('not_linked')
    await tx.offer.updateMany({
      where: { id: offerId, organizationId },
      data: push === 'stock' ? { stockPushSeq: { increment: 1 } } : { pricePushSeq: { increment: 1 } },
    })
    await appendEvent(tx, {
      organizationId,
      type: 'offer.push_retried',
      subject: { type: 'offer', id: offerId },
      payload: { push, actor },
    })
    return offer.connectionId
  }, TX_OPTIONS)

  if (push === 'stock') await requestStockPushAfterCommit(ctx, organizationId, [connectionId])
  else await requestPricePushAfterCommit(ctx, organizationId, [connectionId])
}

/**
 * What the panel shows about an Offer's stock on its Channel. `unset`: its Product's Stock was never saved, so nothing
 * is sent (#137). `not_sent`: handled without a push (an ended Offer told 0).
 */
export type StockPushStatus = 'not_linked' | 'unset' | 'pending' | 'rejected' | 'not_sent' | 'pushed'

export interface OfferStockView {
  publication: OfferPublication | null
  lastPushedAvailable: number | null
  lastPushedAt: Date | null
  /** The code the Channel (or ADR 0022) refused the last stock push with, while nothing newer is waiting. */
  stockRejection: PushRejection | null
  stockStatus: StockPushStatus
}

/** Select for `describeOfferStock`. */
export const offerStockColumns = {
  productId: true,
  channelStatus: true,
  channelEndedReason: true,
  lastPushedAvailable: true,
  lastPushedAt: true,
  stockPushSeq: true,
  stockPushedSeq: true,
  stockRejectedCode: true,
  stockRejectedAt: true,
} as const

/**
 * `stockSet`: whether the Offer's Product has Stock (`productsWithStock`). Unset Stock comes before every push state:
 * whatever is waiting or was refused, nothing is sent until the Stock is saved.
 */
export function describeOfferStock(
  offer: {
    productId: string | null
    channelStatus: OfferPublicationStatus | null
    channelEndedReason: OfferEndedReason | null
    lastPushedAvailable: number | null
    lastPushedAt: Date | null
    stockPushSeq: number
    stockPushedSeq: number
    stockRejectedCode: string | null
    stockRejectedAt: Date | null
  },
  stockSet: boolean,
): OfferStockView {
  const awaitingPush = offer.stockPushSeq > offer.stockPushedSeq
  const stockRejection = currentRejection(offer.stockRejectedCode, offer.stockRejectedAt, awaitingPush)
  const stockStatus: StockPushStatus =
    offer.productId === null
      ? 'not_linked'
      : !stockSet
        ? 'unset'
        : awaitingPush
          ? 'pending'
          : stockRejection
            ? 'rejected'
            : offer.lastPushedAt === null
              ? 'not_sent'
              : 'pushed'
  return {
    publication: publicationFromColumns(offer.channelStatus, offer.channelEndedReason),
    lastPushedAvailable: offer.lastPushedAvailable,
    lastPushedAt: offer.lastPushedAt,
    // Nothing is sent while the Stock is unset, so a refusal of an earlier number no longer says anything.
    stockRejection: stockStatus === 'unset' ? null : stockRejection,
    stockStatus,
  }
}

export interface RejectedOfferRow {
  id: string
  externalId: string
  name: string
  productSku: string | null
  stockRejection: PushRejection | null
  priceRejection: PushRejection | null
}

/** A Connection's Offers whose last stock or price push the Channel refused, newest refusal first. */
export async function listRejectedOffers(ctx: Context, organizationId: string, connectionId: string, limit = 50): Promise<RejectedOfferRow[]> {
  const offers = await ctx.db.offer.findMany({
    where: {
      organizationId,
      connectionId,
      productId: { not: null },
      OR: [{ stockRejectedCode: { not: null } }, { priceRejectedCode: { not: null } }],
    },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      externalId: true,
      name: true,
      stockPushSeq: true,
      stockPushedSeq: true,
      stockRejectedCode: true,
      stockRejectedAt: true,
      pricePushSeq: true,
      pricePushedSeq: true,
      priceRejectedCode: true,
      priceRejectedAt: true,
      product: { select: { sku: true } },
    },
  })
  return offers
    .map((offer) => ({
      id: offer.id,
      externalId: offer.externalId,
      name: offer.name,
      productSku: offer.product?.sku ?? null,
      stockRejection: currentRejection(offer.stockRejectedCode, offer.stockRejectedAt, offer.stockPushSeq > offer.stockPushedSeq),
      priceRejection: currentRejection(offer.priceRejectedCode, offer.priceRejectedAt, offer.pricePushSeq > offer.pricePushedSeq),
    }))
    .filter((offer) => offer.stockRejection !== null || offer.priceRejection !== null)
}
