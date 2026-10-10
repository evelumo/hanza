import { moneySchema, offerSchema, PermanentError, type Money, type Offer } from '@hanza/connector-sdk'
import type { WooProduct, WooVariation } from '../api'
import { toMoneyAmount } from '../decimal'

// An Offer is a simple product ("<product id>") or one variation of a variable product ("<parent id>:<variation id>").
// An order line carries both ids, so an Offer's id never has to be looked up.

export type OfferRef = { kind: 'product'; productId: number } | { kind: 'variation'; parentId: number; variationId: number }

const PRODUCT_ID = /^[1-9]\d*$/
const VARIATION_ID = /^([1-9]\d*):([1-9]\d*)$/

export function productOfferId(productId: number): string {
  return String(productId)
}

export function variationOfferId(parentId: number, variationId: number): string {
  return `${parentId}:${variationId}`
}

/** What an Offer's external id points at; null when it is neither of the two forms (or too large to be an id). */
export function parseOfferId(externalId: string): OfferRef | null {
  const variation = VARIATION_ID.exec(externalId)
  if (variation !== null) {
    const [parentId, variationId] = [Number(variation[1]), Number(variation[2])]
    return Number.isSafeInteger(parentId) && Number.isSafeInteger(variationId) ? { kind: 'variation', parentId, variationId } : null
  }
  if (!PRODUCT_ID.test(externalId)) return null
  const productId = Number(externalId)
  return Number.isSafeInteger(productId) ? { kind: 'product', productId } : null
}

/** The Offer an order line was bought from; null once its product was deleted (WooCommerce then reports product id 0). */
export function lineOfferId(productId: number, variationId: number): string | null {
  if (productId <= 0) return null
  return variationId > 0 ? variationOfferId(productId, variationId) : productOfferId(productId)
}

/** How `offers.pull` treats a product: an Offer itself, the parent of Offers, or nothing (grouped, external, a plugin's type). */
export function productKind(product: Pick<WooProduct, 'type'>): 'simple' | 'variable' | 'other' {
  return product.type === 'simple' || product.type === 'variable' ? product.type : 'other'
}

/** The Channel price; null without a price, without the shop's currency, or when the amount is not money. */
function price(amount: string, currency: string | null): Money | null {
  if (currency === null || amount === '') return null
  const mapped = moneySchema.safeParse({ amount: toMoneyAmount(amount) ?? '', currency })
  return mapped.success ? mapped.data : null
}

const isPublished = (status: string) => status === 'publish'

function validated(offer: Offer): Offer {
  const mapped = offerSchema.safeParse(offer)
  // One invalid Offer fails its whole page, so say which one; paths only.
  if (!mapped.success) {
    throw new PermanentError(`Product ${offer.externalId} was mapped to an invalid Offer: ${mapped.error.issues.map((issue) => issue.path.join('.')).join(', ')}`)
  }
  return mapped.data
}

function offerUrl(permalink: string): string | null {
  return URL.canParse(permalink) ? permalink : null
}

/** A simple product as an Offer. `currency` is the shop's (`GET data/currencies/current`), null when the key may not read it. */
export function mapProductOffer(product: WooProduct, currency: string | null): Offer {
  return validated({
    externalId: productOfferId(product.id),
    sku: product.sku.trim() === '' ? null : product.sku.trim(),
    // WordPress allows a product without a title.
    name: product.name.trim() || `#${product.id}`,
    url: offerUrl(product.permalink),
    price: price(product.price, currency),
    // Never `ended`: WooCommerce keeps a product published at stock 0.
    status: isPublished(product.status) ? 'active' : 'inactive',
  })
}

/** One variation of a variable product as an Offer. */
export function mapVariationOffer(parent: WooProduct, variation: WooVariation, currency: string | null): Offer {
  const sku = variation.sku.trim()
  const options = variation.attributes.map((attribute) => attribute.option.trim()).filter((option) => option !== '')
  const parentName = parent.name.trim() || `#${parent.id}`
  return validated({
    externalId: variationOfferId(parent.id, variation.id),
    // A variation without a SKU of its own reports its parent's, which all such siblings share: not a SKU to link by.
    sku: sku === '' || sku === parent.sku.trim() ? null : sku,
    // As WooCommerce names the order line. A variation that fixes no attribute is told apart by its id.
    name: `${parentName} - ${options.length > 0 ? options.join(', ') : `#${variation.id}`}`,
    url: offerUrl(variation.permalink),
    price: price(variation.price, currency),
    status: isPublished(variation.status) && isPublished(parent.status) ? 'active' : 'inactive',
  })
}
