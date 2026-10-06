import { describeFailure } from '@hanza/core'
import { z } from 'zod'
import { getContext } from './context'
import { errorMessage } from './domain-errors'
import { isMessageKey } from '@/i18n/keys'
import type { Translator } from '@/i18n/types'

/** What every server action returns to `useActionState`. */
export interface ActionState {
  error?: string
  /** Keyed by form field name. */
  fieldErrors?: Record<string, string>
  ok?: boolean
  /** Non-secret submitted values, so a failed form is not emptied. */
  values?: Record<string, string>
}

/** Message for the user in the request's language; unexpected errors are logged (without the user's input) and never shown. */
export function failure(error: unknown, t: Translator, extra?: Pick<ActionState, 'fieldErrors' | 'values'>): ActionState {
  const { message, expected } = errorMessage(error, t)
  if (!expected) {
    // Sanitised: a full Prisma message can quote the query's arguments, such as an email typed into an erasure request.
    getContext().log.error('panel action failed', { error: describeFailure(error) })
  }
  return { error: message, ...extra }
}

/** Schemas carry catalogue keys as messages; anything else (zod's own default text) becomes the generic message. */
export function translateIssue(message: string, t: Translator): string {
  return isMessageKey(message) ? t(message) : t('errors.invalidInput')
}

export function invalidInput(error: z.ZodError, t: Translator, values?: Record<string, string>): ActionState {
  const fieldErrors: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? '')
    if (key && !(key in fieldErrors)) fieldErrors[key] = translateIssue(issue.message, t)
  }
  return { error: t('errors.invalidInput'), fieldErrors, ...(values ? { values } : {}) }
}

export function formText(formData: FormData): Record<string, string> {
  const values: Record<string, string> = {}
  for (const [key, value] of formData.entries()) {
    if (typeof value === 'string') values[key] = value
  }
  return values
}
