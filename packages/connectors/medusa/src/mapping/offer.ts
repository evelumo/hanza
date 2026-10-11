import { moneySchema, offerSchema, PermanentError, type Money, type Offer } from '@hanza/connector-sdk'
import type { MedusaPrice, MedusaVariant } from '../api'
import { toMoneyAmount } from '../decimal'
import { amountOf } from './amount'

// An Offer is a product variant: Medusa sells variants, and an order line names the variant it was bought from.

/** The title Medusa gives the only variant of a product created without options. */
const DEFAULT_VARIANT_TITLE = 'default variant'

const trimmed = (value: string | null | undefined) => (value ?? '').trim()

/** `<product title> - <variant title>`; the variant title alone when the product has none; the product title alone for its default variant. */
export function offerName(variant: Pick<MedusaVariant, 'id' | 'title' | 'product'>): string {
  const product = trimmed(variant.product?.title)
  const title = trimmed(variant.title)
  const suffix = title.toLowerCase() === DEFAULT_VARIANT_TITLE ? '' : title
  if (product !== '' && suffix !== '') return `${product} - ${suffix}`
  return product || title || `#${variant.id}`
}

const isOne = (value: number | string | null | undefined) => value === null || value === undefined || Number(value) <= 1

/**
 * A price anybody pays in that currency: no minimum quantity above 1, not tied to a region, a customer group or a
 * price list. Medusa's admin routes remap the pricing module's rules into `rules`; the raw shapes are read too.
 */
export function isPlainPrice(price: MedusaPrice): boolean {
  const rules = price.rules
  const noRules = rules === null || rules === undefined || (Array.isArray(rules) ? rules.length === 0 : Object.keys(rules).length === 0)
  return (
    noRules &&
    (price.rules_count ?? 0) === 0 &&
    (price.price_rules ?? []).length === 0 &&
    (price.price_list_id ?? null) === null &&
    isOne(price.min_quantity)
  )
}

/**
 * The variant's plain price in `currency` (upper-case ISO code), or null: without such a price, without a currency, or
 * when the amount does not fit `Money`. From `raw_amount.value` when Medusa sends it, else from the number (AGENTS.md).
 */
export function offerPrice(variant: Pick<MedusaVariant, 'prices'>, currency: string | null): Money | null {
  if (currency === null) return null
  const price = (variant.prices ?? []).find((candidate) => candidate.currency_code.trim().toUpperCase() === currency && isPlainPrice(candidate))
  if (price === undefined) return null
  const amount = amountOf(price.raw_amount, price.amount)
  const mapped = moneySchema.safeParse({ amount: amount === null ? '' : (toMoneyAmount(amount) ?? ''), currency })
  return mapped.success ? mapped.data : null
}

/** A variant as an Offer, validated. Never `ended`: Medusa keeps a sold-out variant published. */
export function mapOffer(variant: MedusaVariant, currency: string | null): Offer {
  const sku = trimmed(variant.sku)
  const candidate: Offer = {
    externalId: variant.id,
    sku: sku === '' ? null : sku,
    name: offerName(variant),
    url: null,
    price: offerPrice(variant, currency),
    status: variant.product?.status === 'published' ? 'active' : 'inactive',
  }
  const mapped = offerSchema.safeParse(candidate)
  // One invalid Offer fails its whole page, so say which one; paths only.
  if (!mapped.success) {
    throw new PermanentError(`Variant ${variant.id} was mapped to an invalid Offer: ${mapped.error.issues.map((issue) => issue.path.join('.')).join(', ')}`, {
      cause: mapped.error,
    })
  }
  return mapped.data
}
