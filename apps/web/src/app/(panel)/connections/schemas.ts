import { z } from 'zod'
import { messageKey } from '@/i18n/keys'
import { idSchema, unitsSchema } from '@/lib/schemas'

const NAME_REQUIRED = messageKey('validation.nameRequired')

export const addConnectionSchema = z.object({
  connectorId: idSchema,
  name: z.string({ error: NAME_REQUIRED }).trim().min(1, NAME_REQUIRED).max(100, messageKey('validation.connectionNameTooLong')),
})

export const requestSyncSchema = z.object({ connectionId: idSchema })

/** The Channel limit field must be sent; left empty, it means no limit. A missing field is an error, never "no limit". */
export const stockRulesSchema = z.object({
  connectionId: idSchema,
  safetyBuffer: unitsSchema,
  channelLimit: z
    .string({ error: messageKey('validation.unitsInvalid') })
    .transform((value) => value.trim() || null)
    .pipe(unitsSchema.nullable()),
})
