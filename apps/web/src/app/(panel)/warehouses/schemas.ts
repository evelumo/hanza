import { z } from 'zod'
import { messageKey } from '@/i18n/keys'
import { idSchema, unitsSchema } from '@/lib/schemas'

const NAME_REQUIRED = messageKey('validation.nameRequired')

const warehouseNameSchema = z
  .string({ error: NAME_REQUIRED })
  .trim()
  .min(1, NAME_REQUIRED)
  .max(100, messageKey('validation.warehouseNameTooLong'))

/** Priority may be left empty on create: the Warehouse then goes last. */
export const createWarehouseSchema = z.object({
  name: warehouseNameSchema,
  priority: z
    .string({ error: messageKey('validation.unitsInvalid') })
    .transform((value) => value.trim() || null)
    .pipe(unitsSchema.nullable()),
})

export const updateWarehouseSchema = z.object({ warehouseId: idSchema, name: warehouseNameSchema, priority: unitsSchema })
export const warehouseIdSchema = z.object({ warehouseId: idSchema })
export const setWarehouseActiveSchema = z.object({
  warehouseId: idSchema,
  active: z.enum(['true', 'false'], { error: messageKey('validation.fieldInvalid') }).transform((value) => value === 'true'),
})
