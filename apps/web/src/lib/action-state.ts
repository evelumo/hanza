import { z } from 'zod'
import { getContext } from './context'
import { errorMessage } from './domain-errors'

/** What every server action returns to `useActionState`. */
export interface ActionState {
  error?: string
  /** Keyed by form field name. */
  fieldErrors?: Record<string, string>
  ok?: boolean
  /** Non-secret submitted values, so a failed form is not emptied. */
  values?: Record<string, string>
}

/** Polish message for the user; unexpected errors are logged (without the user's input) and never shown. */
export function failure(error: unknown, extra?: Pick<ActionState, 'fieldErrors' | 'values'>): ActionState {
  const { message, expected } = errorMessage(error)
  if (!expected) {
    getContext().log.error('panel action failed', { error: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown' })
  }
  return { error: message, ...extra }
}

export const INVALID_INPUT_MESSAGE = 'Sprawdź poprawność pól.'

/** Per-field messages come from the schema, so each schema carries its own Polish copy. */
export function invalidInput(error: z.ZodError, values?: Record<string, string>): ActionState {
  const fieldErrors: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? '')
    if (key && !(key in fieldErrors)) fieldErrors[key] = issue.message
  }
  return { error: INVALID_INPUT_MESSAGE, fieldErrors, ...(values ? { values } : {}) }
}

export function formText(formData: FormData): Record<string, string> {
  const values: Record<string, string> = {}
  for (const [key, value] of formData.entries()) {
    if (typeof value === 'string') values[key] = value
  }
  return values
}
