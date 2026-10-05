import { MAX_RETENTION_DAYS } from '@hanza/core'
import { z } from 'zod'
import { messageKey } from '@/i18n/keys'

const DAYS_MESSAGE = messageKey('validation.retentionDaysInvalid')
const EMAIL_MESSAGE = messageKey('validation.emailInvalid')

/** An empty field turns retention off (null). */
export const retentionSchema = z.object({
  retentionDays: z
    .string({ error: DAYS_MESSAGE })
    .trim()
    .regex(/^(\d{1,4})?$/, DAYS_MESSAGE)
    .transform((value) => (value === '' ? null : Number(value)))
    .pipe(z.number().int().min(1, DAYS_MESSAGE).max(MAX_RETENTION_DAYS, DAYS_MESSAGE).nullable()),
})

export const erasureSchema = z.object({
  email: z.string({ error: EMAIL_MESSAGE }).trim().max(320, EMAIL_MESSAGE).pipe(z.email(EMAIL_MESSAGE)),
})
