import { DomainError, type DomainErrorCode } from '@hanza/core'
import en from '../../messages/en.json'
import type { Translator } from '@/i18n/types'

export function domainErrorMessage(t: Translator, code: DomainErrorCode): string {
  return t(`errors.domain.${code}`)
}

/** Text for the user; anything that is not a `DomainError` becomes a generic one, never its own message. */
export function errorMessage(error: unknown, t: Translator): { message: string; expected: boolean } {
  if (error instanceof DomainError && Object.hasOwn(en.errors.domain, error.code)) {
    return { message: domainErrorMessage(t, error.code), expected: true }
  }
  return { message: t('errors.unexpected'), expected: false }
}
