import type { Money, Offer } from '@hanza/connector-sdk'
import type { Actor } from '../actor'
import { systemActor } from '../actor'
import type { Context } from '../context'
import { DomainError } from '../errors'
import { appendEvent } from '../events'
import { rematchAfterCommit } from '../orders/rematch'
import { describeOfferPrice, offerPriceColumns, type OfferPriceView } from '../prices/offer-price'
import { moneyFromColumns } from '../prices/price'
import { requestPricePushAfterCommit } from '../prices/push'
import { requestStockPushAfterCommit } from '../stock/push'
import { TX_OPTIONS } from '../transaction'
import { normalizeSku } from './sku'

export interface OfferRow {
  id: string
  connectionId: string
  connectionName: string
  externalId: string
  sku: string | null
  name: string
  url: string | null
  productId: string | null
  productSku: string | null
  linkedBy: 'sku' | 'manual' | null
  lastSeenAt: Date
}

/**
 * Stores one pulled page of Offers and applies automatic linking: a
 * never-linked Offer is linked by SKU; one linked by SKU follows its SKU
 * (relinked or unlinked); a manually linked or unlinked Offer is left alone.
 *
 * Unlike the panel-facing services this enqueues nothing: when `linked > 0` the
 * caller (the `offers.pull` job) must call `requestStockPush` for the
 * Connection and `rematchUnmatchedLines` itself, after this returns, and
 * `requestPricePush` when `linked` or `repriced` is above 0.
 *
 * The Channel's price is stored as reported and never adopted (ADR 0011); a
 * linked Offer whose Channel currency changed is marked for a price push, since
 * the currency decides whether its price can be pushed at all.
 */
export async function upsertOffers(
  ctx: Context,
  organizationId: string,
  connectionId: string,
  offers: Offer[],
  seenAt: Date,
): Promise<{ created: number; updated: number; linked: number; repriced: number }> {
  return ctx.db.$transaction(async (tx) => {
    const connection = await tx.connection.findFirst({ where: { id: connectionId, organizationId }, select: { id: true } })
    if (!connection) throw new DomainError('not_found')

    const incoming = offers.map((offer) => ({ ...offer, sku: normalizeSku(offer.sku) }))
    const externalIds = [...new Set(incoming.map((offer) => offer.externalId))]
    await tx.$queryRaw`
      SELECT "id" FROM "offer"
      WHERE "organizationId" = ${organizationId} AND "connectionId" = ${connectionId} AND "externalId" = ANY(${externalIds}::text[])
      ORDER BY "id"
      FOR UPDATE`
    const existing = await tx.offer.findMany({
      where: { organizationId, connectionId, externalId: { in: externalIds } },
      select: { id: true, externalId: true, productId: true, linkedBy: true, channelPriceCurrency: true, product: { select: { sku: true } } },
    })
    const current = new Map(existing.map((offer) => [offer.externalId, offer]))

    const skus = [...new Set(incoming.map((offer) => offer.sku).filter((sku): sku is string => sku !== null))]
    const products = await tx.product.findMany({ where: { organizationId, sku: { in: skus } }, select: { id: true, sku: true } })
    const productBySku = new Map(products.map((product) => [product.sku, product.id]))

    const counts = { created: 0, updated: 0, linked: 0, repriced: 0 }
    const linkedEvent = (offerId: string, productId: string) =>
      appendEvent(tx, {
        organizationId,
        type: 'offer.linked',
        subject: { type: 'offer', id: offerId },
        payload: { productId, linkedBy: 'sku', actor: systemActor },
      })

    for (const offer of incoming) {
      const match = offer.sku ? productBySku.get(offer.sku) : undefined
      const known = current.get(offer.externalId)
      const channelPrice = offer.price ?? null
      const fields = {
        sku: offer.sku,
        name: offer.name,
        url: offer.url,
        channelPriceAmount: channelPrice?.amount ?? null,
        channelPriceCurrency: channelPrice?.currency ?? null,
        lastSeenAt: seenAt,
      }

      if (!known) {
        const created = await tx.offer.create({
          data: {
            organizationId,
            connectionId,
            externalId: offer.externalId,
            ...fields,
            productId: match ?? null,
            linkedBy: match ? 'sku' : null,
            stockPushSeq: match ? 1 : 0,
            pricePushSeq: match ? 1 : 0,
          },
          select: { id: true },
        })
        current.set(offer.externalId, {
          id: created.id,
          externalId: offer.externalId,
          productId: match ?? null,
          linkedBy: match ? 'sku' : null,
          channelPriceCurrency: fields.channelPriceCurrency,
          product: match && offer.sku ? { sku: offer.sku } : null,
        })
        counts.created++
        if (match) {
          counts.linked++
          await linkedEvent(created.id, match)
        }
        continue
      }

      let link: { productId: string | null; linkedBy: 'sku' | null } | undefined
      if (known.linkedBy === null && match) {
        link = { productId: match, linkedBy: 'sku' }
      } else if (known.linkedBy === 'sku' && known.product?.sku !== offer.sku) {
        link = match ? { productId: match, linkedBy: 'sku' } : { productId: null, linkedBy: null }
      }

      const linkedTo = link ? link.productId : known.productId
      const repriced = linkedTo !== null && (link !== undefined || known.channelPriceCurrency !== fields.channelPriceCurrency)
      await tx.offer.updateMany({
        where: { id: known.id, organizationId },
        data: {
          ...fields,
          ...(link ? { ...link, ...(link.productId ? { stockPushSeq: { increment: 1 } } : {}) } : {}),
          ...(repriced ? { pricePushSeq: { increment: 1 } } : {}),
        },
      })
      counts.updated++
      if (repriced) counts.repriced++
      if (link) {
        if (known.productId && known.productId !== link.productId) {
          await appendEvent(tx, {
            organizationId,
            type: 'offer.unlinked',
            subject: { type: 'offer', id: known.id },
            payload: { productId: known.productId, linkedBy: link.linkedBy, actor: systemActor },
          })
        }
        if (link.productId) {
          counts.linked++
          await linkedEvent(known.id, link.productId)
        }
        current.set(offer.externalId, {
          ...known,
          channelPriceCurrency: fields.channelPriceCurrency,
          productId: link.productId,
          linkedBy: link.linkedBy,
          product: link.productId && offer.sku ? { sku: offer.sku } : null,
        })
      }
    }
    return counts
  }, TX_OPTIONS)
}

/** Links by hand; automatic linking never touches the Offer again. */
export async function linkOffer(ctx: Context, organizationId: string, offerId: string, productId: string, actor: Actor): Promise<void> {
  const connectionId = await ctx.db.$transaction(async (tx) => {
    const offer = await tx.offer.findFirst({ where: { id: offerId, organizationId }, select: { connectionId: true } })
    if (!offer) throw new DomainError('not_found')
    const product = await tx.product.findFirst({ where: { id: productId, organizationId }, select: { id: true } })
    if (!product) throw new DomainError('not_found')
    await tx.offer.updateMany({
      where: { id: offerId, organizationId },
      data: { productId, linkedBy: 'manual', stockPushSeq: { increment: 1 }, pricePushSeq: { increment: 1 } },
    })
    await appendEvent(tx, {
      organizationId,
      type: 'offer.linked',
      subject: { type: 'offer', id: offerId },
      payload: { productId, linkedBy: 'manual', actor },
    })
    return offer.connectionId
  }, TX_OPTIONS)

  await requestStockPushAfterCommit(ctx, organizationId, [connectionId])
  await requestPricePushAfterCommit(ctx, organizationId, [connectionId])
  await rematchAfterCommit(ctx, organizationId, { offerId })
}

/** Unlinks by hand; pushes nothing, and automatic linking never touches the Offer again. */
export async function unlinkOffer(ctx: Context, organizationId: string, offerId: string, actor: Actor): Promise<void> {
  await ctx.db.$transaction(async (tx) => {
    const offer = await tx.offer.findFirst({ where: { id: offerId, organizationId }, select: { productId: true } })
    if (!offer) throw new DomainError('not_found')
    await tx.offer.updateMany({ where: { id: offerId, organizationId }, data: { productId: null, linkedBy: 'manual' } })
    if (offer.productId) {
      await appendEvent(tx, {
        organizationId,
        type: 'offer.unlinked',
        subject: { type: 'offer', id: offerId },
        payload: { productId: offer.productId, linkedBy: 'manual', actor },
      })
    }
  }, TX_OPTIONS)
}

export async function listOffers(
  ctx: Context,
  organizationId: string,
  query: { linked?: boolean; skip: number; take: number },
): Promise<{ total: number; items: OfferRow[] }> {
  const where = {
    organizationId,
    ...(query.linked === undefined ? {} : { productId: query.linked ? { not: null } : null }),
  }
  const [total, offers] = await Promise.all([
    ctx.db.offer.count({ where }),
    ctx.db.offer.findMany({
      where,
      orderBy: [{ connectionId: 'asc' }, { externalId: 'asc' }],
      skip: query.skip,
      take: query.take,
      include: { connection: { select: { name: true } }, product: { select: { sku: true } } },
    }),
  ])
  return {
    total,
    items: offers.map((offer) => ({
      id: offer.id,
      connectionId: offer.connectionId,
      connectionName: offer.connection.name,
      externalId: offer.externalId,
      sku: offer.sku,
      name: offer.name,
      url: offer.url,
      productId: offer.productId,
      productSku: offer.product?.sku ?? null,
      linkedBy: offer.linkedBy,
      lastSeenAt: offer.lastSeenAt,
    })),
  }
}

export interface OfferDetail extends OfferPriceView {
  id: string
  connectionId: string
  connectionName: string
  externalId: string
  sku: string | null
  name: string
  url: string | null
  linkedBy: 'sku' | 'manual' | null
  lastSeenAt: Date
  product: { id: string; sku: string; name: string; basePrice: Money | null } | null
}

export async function getOffer(ctx: Context, organizationId: string, offerId: string): Promise<OfferDetail | null> {
  const offer = await ctx.db.offer.findFirst({
    where: { id: offerId, organizationId },
    select: {
      id: true,
      connectionId: true,
      externalId: true,
      sku: true,
      name: true,
      url: true,
      linkedBy: true,
      lastSeenAt: true,
      ...offerPriceColumns,
      connection: { select: { name: true, connectorId: true } },
      product: { select: { id: true, sku: true, name: true, basePriceAmount: true, basePriceCurrency: true } },
    },
  })
  if (!offer) return null
  const product = offer.product
    ? {
        id: offer.product.id,
        sku: offer.product.sku,
        name: offer.product.name,
        basePrice: moneyFromColumns(offer.product.basePriceAmount, offer.product.basePriceCurrency),
      }
    : null
  return {
    id: offer.id,
    connectionId: offer.connectionId,
    connectionName: offer.connection.name,
    externalId: offer.externalId,
    sku: offer.sku,
    name: offer.name,
    url: offer.url,
    linkedBy: offer.linkedBy,
    lastSeenAt: offer.lastSeenAt,
    product,
    ...describeOfferPrice(ctx, { ...offer, connectorId: offer.connection.connectorId }, product),
  }
}

/** Linked Offers whose push sequence is ahead of the last pushed one, by id. */
export async function listOffersAwaitingStockPush(
  ctx: Context,
  organizationId: string,
  connectionId: string,
  limit: number,
): Promise<Array<{ offerId: string; externalId: string; sku: string | null; productId: string; seq: number }>> {
  return ctx.db.$queryRaw`
    SELECT "id" AS "offerId", "externalId", "sku", "productId", "stockPushSeq" AS "seq"
    FROM "offer"
    WHERE "organizationId" = ${organizationId} AND "connectionId" = ${connectionId}
      AND "productId" IS NOT NULL AND "stockPushSeq" > "stockPushedSeq"
    ORDER BY "id"
    LIMIT ${limit}`
}

/**
 * Compare-and-clear: records `seq` as pushed only if it is still ahead, so a
 * bump that happened after the list was read keeps the Offer pending.
 */
export async function markOffersPushed(
  ctx: Context,
  organizationId: string,
  pushed: Array<{ offerId: string; seq: number; available: number }>,
): Promise<void> {
  const sorted = [...pushed].sort((a, b) => (a.offerId < b.offerId ? -1 : a.offerId > b.offerId ? 1 : 0))
  for (const item of sorted) {
    await ctx.db.$executeRaw`
      UPDATE "offer"
      SET "stockPushedSeq" = ${item.seq}, "lastPushedAvailable" = ${item.available}, "lastPushedAt" = now(), "updatedAt" = now()
      WHERE "id" = ${item.offerId} AND "organizationId" = ${organizationId} AND "stockPushedSeq" < ${item.seq}`
  }
}
