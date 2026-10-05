import type { MessageKey } from '@/i18n/types'

// Better Auth error codes we can explain; its own message is English, so it is never shown.
const keys: Record<string, MessageKey> = {
  USER_ALREADY_EXISTS: 'auth.errors.userExists',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'auth.errors.userExists',
  INVALID_EMAIL: 'auth.errors.invalidEmail',
  PASSWORD_TOO_SHORT: 'auth.errors.passwordTooShort',
  PASSWORD_TOO_LONG: 'auth.errors.passwordTooLong',
}

/** The catalogue key for a Better Auth error code, or the given fallback when the code is not one we explain. */
export function authErrorKey(code: string | undefined, fallback: MessageKey): MessageKey {
  return (code && Object.hasOwn(keys, code) ? keys[code] : undefined) ?? fallback
}
