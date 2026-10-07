import type { Money } from '@hanza/connector-sdk'
import { currentRejection, type PushRejection } from '../catalog/offer-push'
import type { Context } from '../context'
import { effectivePrice, moneyFromColumns, priceStatus, type PriceStatus } from './price'

/** An Offer's price as the panel shows it. */
export interface OfferPriceView {
  /** What the Channel reported at the last pull; never adopted. */
  channelPrice: Money | null
  priceOverride: Money | null
  /** Override, else the linked Product's base price. */
  effectivePrice: Money | null
  lastPushedPrice: Money | null
  lastPricePushedAt: Date | null
  /** The code the Channel refused the last price push with, while nothing newer is waiting. */
  priceRejection: PushRejection | null
  priceStatus: PriceStatus
}

type Amount = { toFixed(): string } | null

export interface OfferPriceColumns {
  channelPriceAmount: Amount
  channelPriceCurrency: string | null
  priceOverrideAmount: Amount
  priceOverrideCurrency: string | null
  lastPushedPriceAmount: Amount
  lastPushedPriceCurrency: string | null
  lastPricePushedAt: Date | null
  pricePushSeq: number
  pricePushedSeq: number
  priceRejectedCode: string | null
  priceRejectedAt: Date | null
}

/** Select for `describeOfferPrice`. */
export const offerPriceColumns = {
  channelPriceAmount: true,
  channelPriceCurrency: true,
  priceOverrideAmount: true,
  priceOverrideCurrency: true,
  lastPushedPriceAmount: true,
  lastPushedPriceCurrency: true,
  lastPricePushedAt: true,
  pricePushSeq: true,
  pricePushedSeq: true,
  priceRejectedCode: true,
  priceRejectedAt: true,
} as const

export function describeOfferPrice(
  ctx: Context,
  offer: OfferPriceColumns & { connectorId: string },
  product: { basePrice: Money | null } | null,
): OfferPriceView {
  const channelPrice = moneyFromColumns(offer.channelPriceAmount, offer.channelPriceCurrency)
  const priceOverride = moneyFromColumns(offer.priceOverrideAmount, offer.priceOverrideCurrency)
  const effective = effectivePrice(priceOverride, product?.basePrice ?? null)
  const lastPushedPrice = moneyFromColumns(offer.lastPushedPriceAmount, offer.lastPushedPriceCurrency)
  const awaitingPush = offer.pricePushSeq > offer.pricePushedSeq
  const priceRejection = currentRejection(offer.priceRejectedCode, offer.priceRejectedAt, awaitingPush)
  return {
    channelPrice,
    priceOverride,
    effectivePrice: effective,
    lastPushedPrice,
    lastPricePushedAt: offer.lastPricePushedAt,
    priceRejection,
    priceStatus: priceStatus({
      linked: product !== null,
      supported: typeof ctx.connectors.get(offer.connectorId)?.capabilities['price.push'] === 'function',
      effective,
      channelCurrency: channelPrice?.currency ?? null,
      lastPushed: lastPushedPrice,
      awaitingPush,
      rejected: priceRejection !== null,
    }),
  }
}
