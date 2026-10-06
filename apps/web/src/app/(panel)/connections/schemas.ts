import { z } from 'zod'
import { messageKey } from '@/i18n/keys'
import { idSchema, unitsSchema } from '@/lib/schemas'

const NAME_REQUIRED = messageKey('validation.nameRequired')

export const addConnectionSchema = z.object({
  connectorId: idSchema,
  name: z.string({ error: NAME_REQUIRED }).trim().min(1, NAME_REQUIRED).max(100, messageKey('validation.connectionNameTooLong')),
})

export const requestSyncSchema = z.object({ connectionId: idSchema })

const WAREHOUSES_REQUIRED = messageKey('validation.warehousesRequired')

/** `all`: every active Warehouse counts; `only`: just the ticked ones, at least one. */
export const channelWarehousesSchema = z.discriminatedUnion(
  'mode',
  [
    z.object({ connectionId: idSchema, mode: z.literal('all') }),
    z.object({
      connectionId: idSchema,
      mode: z.literal('only'),
      warehouseIds: z.array(idSchema, { error: WAREHOUSES_REQUIRED }).min(1, WAREHOUSES_REQUIRED).max(100, WAREHOUSES_REQUIRED),
    }),
  ],
  { error: messageKey('validation.fieldInvalid') },
)

/** The Channel limit field must be sent; left empty, it means no limit. A missing field is an error, never "no limit". */
export const stockRulesSchema = z.object({
  connectionId: idSchema,
  safetyBuffer: unitsSchema,
  channelLimit: z
    .string({ error: messageKey('validation.unitsInvalid') })
    .transform((value) => value.trim() || null)
    .pipe(unitsSchema.nullable()),
})
