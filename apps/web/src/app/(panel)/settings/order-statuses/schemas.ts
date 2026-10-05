import { ORDER_PHASES, ORDER_STATUS_COLORS, ORDER_STATUS_NAME_MAX } from '@hanza/core'
import { z } from 'zod'
import { messageKey } from '@/i18n/keys'
import { idSchema } from '@/lib/schemas'

const NAME_REQUIRED = messageKey('validation.statusNameRequired')
const NAME_TOO_LONG = messageKey('validation.statusNameTooLong')
const FIELD_INVALID = messageKey('validation.fieldInvalid')

const nameSchema = z.string({ error: NAME_REQUIRED }).trim().min(1, NAME_REQUIRED).max(ORDER_STATUS_NAME_MAX, NAME_TOO_LONG)
/** Empty means the phase's own name (null). */
const optionalNameSchema = z
  .string({ error: NAME_TOO_LONG })
  .trim()
  .max(ORDER_STATUS_NAME_MAX, NAME_TOO_LONG)
  .transform((name) => (name === '' ? null : name))
/** Empty means the phase's colour (null). */
const colorSchema = z
  .enum(['', ...ORDER_STATUS_COLORS], { error: messageKey('validation.colorInvalid') })
  .transform((color) => (color === '' ? null : color))

export const createOrderStatusSchema = z.object({
  phase: z.enum(ORDER_PHASES, { error: messageKey('validation.phaseInvalid') }),
  name: nameSchema,
  color: colorSchema,
})
export const updateOrderStatusSchema = z.object({ statusId: idSchema, name: optionalNameSchema, color: colorSchema })
export const moveOrderStatusSchema = z.object({ statusId: idSchema, direction: z.enum(['up', 'down'], { error: FIELD_INVALID }) })
export const setOrderStatusActiveSchema = z.object({
  statusId: idSchema,
  active: z.enum(['1', '0'], { error: FIELD_INVALID }).transform((value) => value === '1'),
})
export const orderStatusIdSchema = z.object({ statusId: idSchema })
export const deleteOrderStatusSchema = z.object({
  statusId: idSchema,
  replacementId: z
    .union([z.literal(''), idSchema], { error: messageKey('validation.idInvalid') })
    .optional()
    .transform((id) => (id ? id : null)),
})
