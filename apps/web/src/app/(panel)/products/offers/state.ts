import type { CreateProductsSkipReason } from '@hanza/core'
import type { ActionState } from '@/lib/action-state'

export interface CreateProductsState extends ActionState {
  created?: number
  skipped?: Array<{ offerId: string; reason: CreateProductsSkipReason }>
}

export const skipReasonLabels: Record<CreateProductsSkipReason, string> = {
  not_found: 'nie znaleziono oferty',
  no_sku: 'oferta nie ma SKU',
  sku_taken: 'produkt z tym SKU już istnieje',
  already_linked: 'oferta jest już połączona',
}
