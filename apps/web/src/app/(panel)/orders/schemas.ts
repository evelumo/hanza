import { ORDER_PHASES } from '@hanza/core'
import { z } from 'zod'
import { messageKey } from '@/i18n/keys'
import { idSchema, skuSchema } from '@/lib/schemas'

const CARRIER_REQUIRED = messageKey('validation.carrierRequired')
const SERVICE_REQUIRED = messageKey('validation.serviceRequired')

/** The target is an Order status of the organization; the core checks it belongs to it and may be chosen. */
export const changeOrderStatusSchema = z.object({ orderId: idSchema, statusId: idSchema })
export const linkOrderLineSchema = z.object({ orderLineId: idSchema, sku: skuSchema })
export const resolveAttentionSchema = z.object({ orderId: idSchema })
export const moveReservationSchema = z.object({ orderLineId: idSchema, warehouseId: idSchema })

/**
 * What every "Create shipment" form sends, whichever service it is for; the fields of the service are read by
 * `shipmentFormSchema` once the server knows it. The service id is a connector's own, not one of Hanza's ids.
 */
export const createShipmentSchema = z.object({
  orderId: idSchema,
  connectionId: z.string({ error: CARRIER_REQUIRED }).min(1, CARRIER_REQUIRED).max(64, CARRIER_REQUIRED),
  service: z.string({ error: SERVICE_REQUIRED }).min(1, SERVICE_REQUIRED).max(200, SERVICE_REQUIRED),
})
export const shipmentActionSchema = z.object({ shipmentId: idSchema })

const phaseSchema = z.enum(ORDER_PHASES)

/**
 * `status` is a status id: one of another organization simply matches nothing, as the list is scoped by tenant. Links
 * from before organizations had statuses carry a phase there (`?status=new`); it becomes the phase filter.
 */
export const orderListFiltersSchema = z
  .object({
    phase: phaseSchema.optional().catch(undefined),
    status: idSchema.optional().catch(undefined),
    attention: z.literal('1').optional().catch(undefined),
    payment: z.literal('awaiting').optional().catch(undefined),
  })
  .transform((filters) => {
    const legacyPhase = phaseSchema.safeParse(filters.status)
    return legacyPhase.success ? { ...filters, phase: filters.phase ?? legacyPhase.data, status: undefined } : filters
  })
