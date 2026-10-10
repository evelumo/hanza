import { pushRejectionCodeSchema, type StockLevel, type StockPushResult } from '@hanza/connector-sdk'
import { WOO_PRODUCT_TYPE_FIELDS, wooBatchResponseSchema, wooProductTypesSchema, type WooBatchItem } from '../api'
import { request } from '../client'
import { parseOfferId } from '../mapping/offer'
import type { WooCommerceContext } from '../settings'

/** WooCommerce refuses a batch of more items as a whole (413). */
export const MAX_BATCH_ITEMS = 100

/** The rejection codes the connector gives itself; every other code is the one WooCommerce gave for the item. */
export const REJECTION = {
  /** The Offer's external id is neither `<product id>` nor `<parent id>:<variation id>`. */
  invalidOfferId: 'invalid_offer_id',
  /** WooCommerce answered 200 without taking the number into use: stock management is off for the whole shop. */
  stockNotManaged: 'stock_not_managed',
  /** The id is a product, but no longer a simple one (it was made variable, grouped, ...): not an Offer any more. */
  notAnOffer: 'not_a_simple_product',
  /** The batch's answer does not mention the item. */
  notConfirmed: 'not_confirmed',
  /** WooCommerce refused the item with a code that is not a short machine code. */
  unknownError: 'unknown_error',
  /**
   * WooCommerce's own codes for an id it does not have. Also given here to a product the shop does not list (it
   * is in the trash, or gone) without asking for it, and to anything that turns out to be in the trash.
   */
  unknownProduct: 'woocommerce_rest_product_invalid_id',
  unknownVariation: 'woocommerce_rest_product_variation_invalid_id',
} as const

interface Target {
  offerExternalId: string
  /** The product's id, or the variation's. */
  id: number
  available: number
}

interface Batch {
  path: string
  /** What `type` the answer gives an item that is an Offer. */
  type: 'simple' | 'variation'
  /** The code for an item that is not there. */
  unknown: string
  targets: Target[]
}

/** Rejection codes by Offer external id; an Offer without one was applied. */
type Rejections = Map<string, string>

function chunks<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size))
}

/** Why an item was not applied; null when it was. */
function rejection(batch: Batch, target: Target, answer: WooBatchItem | undefined): string | null {
  // An Offer left out of the results counts as applied, and nothing here says this one was.
  if (answer === undefined) return REJECTION.notConfirmed
  if (answer.error !== undefined) {
    // Only a code may leave the connector: a message can echo data.
    return pushRejectionCodeSchema.safeParse(answer.error.code).success ? answer.error.code : REJECTION.unknownError
  }
  // WooCommerce updates what is in the trash like anything else (a variation goes there with its parent). No
  // Buyer sees it and `offers.pull` does not list it: the Offer is gone, whatever number it now holds.
  if (answer.status === 'trash') return batch.unknown
  // The products were read before they were sent (`pushProducts`); this catches one that changed in between.
  if (answer.type !== undefined && answer.type !== batch.type) return REJECTION.notAnOffer
  // With the shop's stock management off the answer is a 200 with `manage_stock: false`, and Buyers can buy
  // without limit: a simple product keeps the number it had, a variation stores the new one and does not use it.
  if (answer.manage_stock !== true || answer.stock_quantity !== target.available) return REJECTION.stockNotManaged
  return null
}

async function send(ctx: WooCommerceContext, batch: Batch): Promise<Rejections> {
  const { data } = await request(ctx, {
    method: 'POST',
    path: batch.path,
    // The push turns stock management on for the product: without it WooCommerce ignores the number, and Hanza
    // owns Stock (ADR 0001).
    body: { update: batch.targets.map((target) => ({ id: target.id, manage_stock: true, stock_quantity: target.available })) },
    schema: wooBatchResponseSchema,
    what: 'stock update',
  })
  const answers = new Map(data.update.map((item) => [item.id, item]))
  const rejected: Rejections = new Map()
  for (const target of batch.targets) {
    const code = rejection(batch, target, answers.get(target.id))
    if (code !== null) rejected.set(target.offerExternalId, code)
  }
  return rejected
}

/**
 * At most `MAX_BATCH_ITEMS` simple products. `products/batch` sets the number of whatever product has the id, and an
 * Offer that was a simple product when it was pulled may be a variable one by now: its number is then the one every
 * variation on `"parent"` stock sells from. So the products are read first, and only the simple ones are sent.
 */
async function pushProducts(ctx: WooCommerceContext, targets: Target[]): Promise<Rejections> {
  const { data } = await request(ctx, {
    path: 'products',
    query: { include: targets.map((target) => target.id), per_page: MAX_BATCH_ITEMS, _fields: WOO_PRODUCT_TYPE_FIELDS },
    schema: wooProductTypesSchema,
    what: 'products',
  })
  const types = new Map(data.map((product) => [product.id, product.type]))
  const rejected: Rejections = new Map()
  const simple: Target[] = []
  for (const target of targets) {
    const type = types.get(target.id)
    // Not listed: no such product, a variation's id, or a product in the trash.
    if (type === undefined) rejected.set(target.offerExternalId, REJECTION.unknownProduct)
    else if (type !== 'simple') rejected.set(target.offerExternalId, REJECTION.notAnOffer)
    else simple.push(target)
  }
  if (simple.length === 0) return rejected
  const refused = await send(ctx, { path: 'products/batch', type: 'simple', unknown: REJECTION.unknownProduct, targets: simple })
  return new Map([...rejected, ...refused])
}

/**
 * `stock.push`: sets `stock_quantity` with one `products/batch` request for the simple products (after one read of
 * what they are now) and one `products/<parent>/variations/batch` request per variable product, and returns a
 * result for every Offer that was not applied (Offers left out were). Never `ended`: WooCommerce keeps a product at
 * 0 published.
 *
 * A variations batch needs no read: under a parent that is gone, is not a variable product or does not own the
 * variation, WooCommerce refuses each item by itself (`woocommerce_rest_product_variation_invalid_id`) behind a 200.
 */
export async function pushStock(ctx: WooCommerceContext, levels: StockLevel[]): Promise<StockPushResult[]> {
  // One result per Offer at most (the core refuses two): a level given twice counts once, with its last number.
  const unique = new Map(levels.map((level) => [level.offerExternalId, level]))
  const rejected: Rejections = new Map()
  const products: Target[] = []
  const variations = new Map<number, Target[]>()
  for (const { offerExternalId, available } of unique.values()) {
    const ref = parseOfferId(offerExternalId)
    if (ref === null) {
      rejected.set(offerExternalId, REJECTION.invalidOfferId)
    } else if (ref.kind === 'product') {
      products.push({ offerExternalId, id: ref.productId, available })
    } else {
      const siblings = variations.get(ref.parentId) ?? []
      siblings.push({ offerExternalId, id: ref.variationId, available })
      variations.set(ref.parentId, siblings)
    }
  }

  // One request after another: the Connection may have two in flight, and a pull may be running. A request that
  // fails rejects the whole call, also when earlier batches were applied: the core tries the call again, and
  // setting the same numbers a second time changes nothing.
  const steps: Array<() => Promise<Rejections>> = [
    ...chunks(products, MAX_BATCH_ITEMS).map((targets) => () => pushProducts(ctx, targets)),
    ...[...variations].flatMap(([parentId, targets]) =>
      chunks(targets, MAX_BATCH_ITEMS).map(
        (part) => () => send(ctx, { path: `products/${parentId}/variations/batch`, type: 'variation', unknown: REJECTION.unknownVariation, targets: part }),
      ),
    ),
  ]
  for (const step of steps) {
    for (const [offerExternalId, code] of await step()) rejected.set(offerExternalId, code)
  }

  return [...unique.keys()].flatMap((offerExternalId) => {
    const code = rejected.get(offerExternalId)
    return code === undefined ? [] : [{ offerExternalId, outcome: 'rejected' as const, code }]
  })
}
