import { orderStatusSchema } from '@hanza/connector-sdk'
import { z } from 'zod'
import { idSchema, skuSchema } from '@/lib/schemas'

export const changeOrderStatusSchema = z.object({ orderId: idSchema, status: orderStatusSchema })
export const linkOrderLineSchema = z.object({ orderLineId: idSchema, orderId: idSchema, sku: skuSchema })
export const resolveAttentionSchema = z.object({ orderId: idSchema })

export const orderListFiltersSchema = z.object({
  status: orderStatusSchema.optional().catch(undefined),
  attention: z.literal('1').optional().catch(undefined),
})
