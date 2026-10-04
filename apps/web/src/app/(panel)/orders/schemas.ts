import { orderStatusSchema } from '@hanza/connector-sdk'
import { z } from 'zod'
import { idSchema, skuSchema } from '@/lib/schemas'

// The SDK's enum has zod's English messages; the form field is hidden-ish (a select), so give it Polish ones.
const formStatusSchema = z.enum(orderStatusSchema.options, { error: 'Wybierz poprawny status.' })

export const changeOrderStatusSchema = z.object({ orderId: idSchema, status: formStatusSchema })
export const linkOrderLineSchema = z.object({ orderLineId: idSchema, sku: skuSchema })
export const resolveAttentionSchema = z.object({ orderId: idSchema })

export const orderListFiltersSchema = z.object({
  status: orderStatusSchema.optional().catch(undefined),
  attention: z.literal('1').optional().catch(undefined),
})
