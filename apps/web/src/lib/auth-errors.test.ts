import { describe, expect, it } from 'vitest'
import { catalogues } from '@/i18n/catalogues'
import { translatorFor } from '@/i18n/testing'
import { authErrorKey } from './auth-errors'

describe('authErrorKey', () => {
  it('explains the codes it knows, in either language', () => {
    expect(authErrorKey('USER_ALREADY_EXISTS', 'auth.register.failed')).toBe('auth.errors.userExists')
    expect(translatorFor('en')(authErrorKey('PASSWORD_TOO_SHORT', 'auth.register.failed'))).toBe('The password is too short.')
    expect(catalogues.pl.auth.errors.passwordTooShort).not.toBe(catalogues.en.auth.errors.passwordTooShort)
    expect(translatorFor('pl')(authErrorKey('PASSWORD_TOO_SHORT', 'auth.register.failed'))).toBe(catalogues.pl.auth.errors.passwordTooShort)
  })

  it('falls back for an unknown, missing or inherited code instead of showing the server message', () => {
    expect(authErrorKey('SOMETHING_NEW', 'auth.register.failed')).toBe('auth.register.failed')
    expect(authErrorKey(undefined, 'auth.onboarding.failed')).toBe('auth.onboarding.failed')
    expect(authErrorKey('constructor', 'auth.register.failed')).toBe('auth.register.failed')
  })
})
