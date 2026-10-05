import { z } from 'zod'
import { messageKey } from '@/i18n/keys'
import { idSchema } from '@/lib/schemas'

const NAME_REQUIRED = messageKey('validation.nameRequired')

export const addConnectionSchema = z.object({
  connectorId: idSchema,
  name: z.string({ error: NAME_REQUIRED }).trim().min(1, NAME_REQUIRED).max(100, messageKey('validation.connectionNameTooLong')),
})

export const requestSyncSchema = z.object({ connectionId: idSchema })
