import { ORDER_PHASES } from '@hanza/core'
import { z } from 'zod'
import { idSchema, skuSchema } from '@/lib/schemas'

/** The target is an Order status of the organization; the core checks it belongs to it and may be chosen. */
export const changeOrderStatusSchema = z.object({ orderId: idSchema, statusId: idSchema })
export const linkOrderLineSchema = z.object({ orderLineId: idSchema, sku: skuSchema })
export const resolveAttentionSchema = z.object({ orderId: idSchema })

/** `status` is a status id: one of another organization simply matches nothing, as the list is scoped by tenant. */
export const orderListFiltersSchema = z.object({
  phase: z.enum(ORDER_PHASES).optional().catch(undefined),
  status: idSchema.optional().catch(undefined),
  attention: z.literal('1').optional().catch(undefined),
})
