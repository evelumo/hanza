import { currencyMinorUnits, moneySchema, type Money } from '@hanza/connector-sdk'
import { Prisma } from '@hanza/db'
import { DomainError } from '../errors'

/** Why an Offer's price is not sent to its Channel. */
export type PriceSkipReason = 'no_price' | 'currency_unknown' | 'currency_mismatch'

/** What the panel shows for an Offer's price. */
export type PriceStatus = 'not_linked' | 'unsupported' | PriceSkipReason | 'pending' | 'rejected' | 'pushed'

/**
 * A price as Hanza stores it: a valid Money with an amount above zero and no more decimal places than the currency
 * has (45.5 JPY is refused, never rounded), the amount in its shortest form ("10.50" → "10.5") so equal prices
 * compare equal. Throws `DomainError('invalid_price')` otherwise.
 */
export function parsePrice(input: Money): Money {
  const parsed = moneySchema.safeParse(input)
  if (!parsed.success) throw new DomainError('invalid_price', 'A price needs a decimal amount (at most 15 + 4 digits) and an ISO currency')
  const amount = new Prisma.Decimal(parsed.data.amount)
  if (amount.lte(0)) throw new DomainError('invalid_price', 'A price must be greater than 0')
  const minorUnits = currencyMinorUnits(parsed.data.currency)
  if (amount.decimalPlaces() > minorUnits) {
    throw new DomainError('invalid_price', `${parsed.data.currency} prices have at most ${minorUnits} decimal places`)
  }
  return { amount: amount.toFixed(), currency: parsed.data.currency }
}

/** Money from a pair of nullable columns; null unless both are set. */
export function moneyFromColumns(amount: { toFixed(): string } | null, currency: string | null): Money | null {
  return amount !== null && currency !== null ? { amount: amount.toFixed(), currency } : null
}

export function sameMoney(a: Money | null, b: Money | null): boolean {
  if (a === null || b === null) return a === b
  return a.currency === b.currency && new Prisma.Decimal(a.amount).eq(b.amount)
}

/** The Offer's override if it has one, else its Product's base price. */
export function effectivePrice(override: Money | null, basePrice: Money | null): Money | null {
  return override ?? basePrice
}

/**
 * Hanza never converts currencies: a price is sent only in the currency the Channel reported for the Offer.
 * An unknown Channel currency (the Channel reported no price) is never guessed.
 */
export function decidePricePush(
  effective: Money | null,
  channelCurrency: string | null,
): { push: Money } | { skip: PriceSkipReason } {
  if (effective === null) return { skip: 'no_price' }
  if (channelCurrency === null) return { skip: 'currency_unknown' }
  if (effective.currency !== channelCurrency) return { skip: 'currency_mismatch' }
  return { push: effective }
}

export function priceStatus(offer: {
  linked: boolean
  /** The Connection's connector implements `price.push`. */
  supported: boolean
  effective: Money | null
  channelCurrency: string | null
  lastPushed: Money | null
  /** The push sequence is ahead of the last handled one. */
  awaitingPush: boolean
  /** The Channel refused the last price push (and nothing newer is waiting). */
  rejected?: boolean
}): PriceStatus {
  if (!offer.linked) return 'not_linked'
  if (!offer.supported) return 'unsupported'
  const decision = decidePricePush(offer.effective, offer.channelCurrency)
  if ('skip' in decision) return decision.skip
  if (offer.awaitingPush) return 'pending'
  if (offer.rejected) return 'rejected'
  if (!sameMoney(offer.lastPushed, decision.push)) return 'pending'
  return 'pushed'
}
