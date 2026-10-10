'use server'

import { listProducts } from '@hanza/core'
import { z } from 'zod'
import { getContext } from '@/lib/context'
import { requireTenant } from '@/lib/session'
import { PALETTE_MAX_QUERY, PALETTE_MIN_QUERY, PALETTE_RESULTS, type PaletteResults } from './search'

const querySchema = z.string().trim().min(PALETTE_MIN_QUERY).max(PALETTE_MAX_QUERY)

/**
 * The command palette's direct results: the organization's Products whose name or SKU contains `query`, through
 * the service the Products list searches with. Orders are not looked up: the core has no service that finds an
 * Order by its number.
 */
export async function searchPaletteAction(query: unknown): Promise<PaletteResults> {
  const { organizationId } = await requireTenant()
  const parsed = querySchema.safeParse(query)
  if (!parsed.success) return { products: [] }
  const { items } = await listProducts(getContext(), organizationId, { search: parsed.data, skip: 0, take: PALETTE_RESULTS })
  return { products: items.map(({ id, sku, name }) => ({ id, sku, name })) }
}
