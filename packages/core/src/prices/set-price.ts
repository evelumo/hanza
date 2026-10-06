import type { Money } from '@hanza/connector-sdk'
import type { Actor } from '../actor'
import type { Context } from '../context'
import { DomainError } from '../errors'
import { appendEvent } from '../events'
import { TX_OPTIONS } from '../transaction'
import { moneyFromColumns, parsePrice, sameMoney } from './price'
import { markOffersForPricePush, requestPricePushAfterCommit } from './push'

/** Sets or clears (null) a Product's base price; every linked Offer without an override is pushed the new price. */
export async function setBasePrice(
  ctx: Context,
  organizationId: string,
  productId: string,
  input: Money | null,
  actor: Actor,
): Promise<void> {
  const price = input === null ? null : parsePrice(input)
  const connectionIds = await ctx.db.$transaction(async (tx) => {
    // NO KEY UPDATE: concurrent Offer links only take KEY SHARE on the Product and need not wait.
    await tx.$queryRaw`SELECT "id" FROM "product" WHERE "id" = ${productId} AND "organizationId" = ${organizationId} FOR NO KEY UPDATE`
    const product = await tx.product.findFirst({
      where: { id: productId, organizationId },
      select: { basePriceAmount: true, basePriceCurrency: true },
    })
    if (!product) throw new DomainError('not_found')
    const current = moneyFromColumns(product.basePriceAmount, product.basePriceCurrency)
    if (sameMoney(current, price)) return []

    await tx.product.updateMany({
      where: { id: productId, organizationId },
      data: { basePriceAmount: price?.amount ?? null, basePriceCurrency: price?.currency ?? null },
    })
    await appendEvent(tx, {
      organizationId,
      type: 'product.price_changed',
      subject: { type: 'product', id: productId },
      payload: { from: current, to: price, actor },
    })
    return markOffersForPricePush(tx, organizationId, [productId])
  }, TX_OPTIONS)

  await requestPricePushAfterCommit(ctx, organizationId, connectionIds)
}

/** Sets or clears (null) an Offer's price override; while set it wins over the Product's base price. */
export async function setOfferPrice(
  ctx: Context,
  organizationId: string,
  offerId: string,
  input: Money | null,
  actor: Actor,
): Promise<void> {
  const price = input === null ? null : parsePrice(input)
  const connectionIds = await ctx.db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "offer" WHERE "id" = ${offerId} AND "organizationId" = ${organizationId} FOR UPDATE`
    const offer = await tx.offer.findFirst({
      where: { id: offerId, organizationId },
      select: { connectionId: true, productId: true, priceOverrideAmount: true, priceOverrideCurrency: true },
    })
    if (!offer) throw new DomainError('not_found')
    const current = moneyFromColumns(offer.priceOverrideAmount, offer.priceOverrideCurrency)
    if (sameMoney(current, price)) return []

    await tx.offer.updateMany({
      where: { id: offerId, organizationId },
      data: {
        priceOverrideAmount: price?.amount ?? null,
        priceOverrideCurrency: price?.currency ?? null,
        pricePushSeq: { increment: 1 },
      },
    })
    await appendEvent(tx, {
      organizationId,
      type: 'offer.price_changed',
      subject: { type: 'offer', id: offerId },
      payload: { from: current, to: price, actor },
    })
    // Only linked Offers are pushed; linking one later bumps it again.
    return offer.productId ? [offer.connectionId] : []
  }, TX_OPTIONS)

  await requestPricePushAfterCommit(ctx, organizationId, connectionIds)
}
