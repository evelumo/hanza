import type { CreateProductsSkipReason } from '@hanza/core'
import type { ActionState } from '@/lib/action-state'

export interface CreateProductsState extends ActionState {
  created?: number
  skipped?: Array<{ offerId: string; reason: CreateProductsSkipReason }>
}
