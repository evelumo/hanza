import { z } from 'zod'
import { idSchema } from '@/lib/schemas'

export const addConnectionSchema = z.object({
  connectorId: idSchema,
  name: z.string({ error: 'Podaj nazwę.' }).trim().min(1, 'Podaj nazwę.').max(100, 'Nazwa może mieć najwyżej 100 znaków.'),
})

export const requestSyncSchema = z.object({ connectionId: idSchema })
