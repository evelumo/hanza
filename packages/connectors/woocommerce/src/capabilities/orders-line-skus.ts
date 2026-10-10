import { classifyConnectorError } from '@hanza/connector-sdk'
import { z } from 'zod'
import type { WooLineItem, WooOrder } from '../api'
import { request } from '../client'
import type { WooCommerceContext } from '../settings'

// A line of a variation that has no SKU of its own carries its parent's, which every such sibling shares. Hanza
// links a line to a Product by its Offer first and by exact SKU second, and the Offer of such a variation has no
// SKU (`mapVariationOffer`): a line that kept the parent's could reserve the Stock of a Product that only happens to
// have that SKU. The line cannot tell an inherited SKU from its own, so the parents are asked.

/** `include` takes what `per_page` returns: 100 at most. */
const MAX_PARENTS_PER_REQUEST = 100
/**
 * Lookups per call. A page of orders has a handful of variable products among its lines; a shop that sends
 * thousands of them must not turn one call into thousands of requests.
 */
export const MAX_LOOKUP_REQUESTS = 3
const SKU_MAX = 255

const parentSkusSchema = z
  .array(z.unknown())
  .max(MAX_PARENTS_PER_REQUEST)
  .pipe(
    z.array(
      z.object({
        id: z.number().int().positive(),
        // Over the limit is read as none: the order line reads such a SKU the same way.
        sku: z
          .string()
          .nullish()
          .transform((value) => (value != null && value.length <= SKU_MAX ? value : '')),
      }),
    ),
  )

function hasSkuToCheck(line: WooLineItem): boolean {
  return line.variation_id > 0 && line.product_id > 0 && line.sku.trim() !== ''
}

/**
 * The SKUs of the variable products the orders' variation lines belong to, by product id (`''` for a parent without
 * one). A parent that is missing from the map is unknown: deleted or in the trash, beyond what one call asks for,
 * or the shop would not say.
 */
export async function readParentSkus(ctx: WooCommerceContext, orders: readonly WooOrder[]): Promise<Map<number, string>> {
  const ids = [...new Set(orders.flatMap((order) => order.line_items.filter(hasSkuToCheck).map((line) => line.product_id)))].sort((a, b) => a - b)
  const asked = ids.slice(0, MAX_LOOKUP_REQUESTS * MAX_PARENTS_PER_REQUEST)
  if (asked.length < ids.length) {
    ctx.log('WooCommerce orders name more variable products than one call asks about: the lines of the others are imported without a SKU', {
      products: ids.length,
      asked: asked.length,
    })
  }
  const skus = new Map<number, string>()
  try {
    for (let from = 0; from < asked.length; from += MAX_PARENTS_PER_REQUEST) {
      const { data } = await request(ctx, {
        path: 'products',
        query: { include: asked.slice(from, from + MAX_PARENTS_PER_REQUEST), per_page: MAX_PARENTS_PER_REQUEST, _fields: ['id', 'sku'] },
        schema: parentSkusSchema,
        what: 'products',
      })
      for (const product of data) skus.set(product.id, product.sku)
    }
  } catch (error) {
    // A key that may read orders but not products (403), or a products answer of another shape. The Order feed must
    // not stop for it: the lines go without a SKU instead, and an unlinked line is shown as Needs attention.
    if (classifyConnectorError(error).kind !== 'permanent') throw error
    ctx.log('WooCommerce did not say which SKUs variations inherit: lines of variations are imported without a SKU', { products: ids.length })
    return new Map()
  }
  return skus
}

/**
 * The order with the SKU removed from every variation line that inherited it, and from every variation line whose
 * parent is unknown: no SKU leaves a line unlinked and visible, a wrong one reserves another Product's Stock.
 */
export function withOwnSkus(order: WooOrder, parentSkus: ReadonlyMap<number, string>): WooOrder {
  return {
    ...order,
    line_items: order.line_items.map((line) => {
      if (!hasSkuToCheck(line)) return line
      const parentSku = parentSkus.get(line.product_id)
      return parentSku === undefined || parentSku.trim() === line.sku.trim() ? { ...line, sku: '' } : line
    }),
  }
}
