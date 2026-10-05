import type { Tx } from '@hanza/db'
import { normalizeSku } from '../catalog/sku'

/**
 * Line matching (§2): the linked Offer first, then the exact SKU, else an
 * Unmatched line (null). Returns one Product id or null per line, in order.
 */
export async function matchLines(
  tx: Tx,
  organizationId: string,
  connectionId: string,
  lines: Array<{ offerExternalId: string | null; sku: string | null }>,
): Promise<Array<string | null>> {
  const offerIds = [...new Set(lines.map((line) => line.offerExternalId).filter((id): id is string => id !== null))]
  const skus = [...new Set(lines.map((line) => normalizeSku(line.sku)).filter((sku): sku is string => sku !== null))]
  const [offers, products] = await Promise.all([
    offerIds.length === 0
      ? []
      : tx.offer.findMany({
          where: { organizationId, connectionId, externalId: { in: offerIds }, productId: { not: null } },
          select: { externalId: true, productId: true },
        }),
    skus.length === 0 ? [] : tx.product.findMany({ where: { organizationId, sku: { in: skus } }, select: { id: true, sku: true } }),
  ])
  const byOffer = new Map(offers.map((offer) => [offer.externalId, offer.productId]))
  const bySku = new Map(products.map((product) => [product.sku, product.id]))
  return lines.map((line) => {
    const viaOffer = line.offerExternalId ? byOffer.get(line.offerExternalId) : undefined
    if (viaOffer) return viaOffer
    const sku = normalizeSku(line.sku)
    return (sku && bySku.get(sku)) || null
  })
}
