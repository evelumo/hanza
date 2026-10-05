import { z } from 'zod'
import { messageKey } from '@/i18n/keys'
import { idSchema } from '@/lib/schemas'

const NAME_REQUIRED = messageKey('validation.nameRequired')

export const addConnectionSchema = z.object({
  connectorId: idSchema,
  name: z.string({ error: NAME_REQUIRED }).trim().min(1, NAME_REQUIRED).max(100, messageKey('validation.connectionNameTooLong')),
})

export const requestSyncSchema = z.object({ connectionId: idSchema })

/** Empty means the phase's default status (no mapping). */
const mappedStatusSchema = z
  .union([z.literal(''), idSchema], { error: messageKey('validation.idInvalid') })
  .transform((id) => (id === '' ? null : id))

/** One select per phase a Channel reports; the core checks each status is an active one of that phase. */
export const statusMappingSchema = z.object({
  connectionId: idSchema,
  new: mappedStatusSchema,
  shipped: mappedStatusSchema,
  cancelled: mappedStatusSchema,
})
