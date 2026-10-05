import { describe, expect, it } from 'vitest'
import { matchAcceptLanguage, resolveLocale } from './resolve-locale'

describe('resolveLocale', () => {
  it('prefers a supported cookie over the Accept-Language header', () => {
    expect(resolveLocale({ cookie: 'en', acceptLanguage: 'pl' })).toBe('en')
    expect(resolveLocale({ cookie: 'pl', acceptLanguage: 'en-US,en;q=0.9' })).toBe('pl')
  })

  it('ignores a cookie that is not a supported locale', () => {
    expect(resolveLocale({ cookie: 'de', acceptLanguage: 'pl' })).toBe('pl')
    expect(resolveLocale({ cookie: 'PL', acceptLanguage: 'en' })).toBe('en')
    expect(resolveLocale({ cookie: '', acceptLanguage: 'pl-PL' })).toBe('pl')
    expect(resolveLocale({ cookie: 'pl; en', acceptLanguage: null })).toBe('en')
  })

  it('falls back to the best match of the header, then to English', () => {
    expect(resolveLocale({ acceptLanguage: 'pl-PL,pl;q=0.9,en;q=0.8' })).toBe('pl')
    expect(resolveLocale({ acceptLanguage: 'fr-FR,fr;q=0.9' })).toBe('en')
    expect(resolveLocale({})).toBe('en')
    expect(resolveLocale({ cookie: null, acceptLanguage: null })).toBe('en')
    expect(resolveLocale({ cookie: undefined, acceptLanguage: '' })).toBe('en')
  })
})

describe('matchAcceptLanguage', () => {
  it('orders by quality, then by position', () => {
    expect(matchAcceptLanguage('de, pl;q=0.8, en;q=0.5')).toBe('pl')
    expect(matchAcceptLanguage('en;q=0.5, pl;q=0.9')).toBe('pl')
    expect(matchAcceptLanguage('pl, en')).toBe('pl')
    expect(matchAcceptLanguage('en, pl')).toBe('en')
  })

  it('matches on the primary language subtag, case-insensitively', () => {
    expect(matchAcceptLanguage('PL-pl')).toBe('pl')
    expect(matchAcceptLanguage('en-GB')).toBe('en')
    expect(matchAcceptLanguage('pl_PL')).toBeNull()
  })

  it('skips unsupported languages, wildcards and q=0', () => {
    expect(matchAcceptLanguage('de, fr;q=0.9, pl;q=0.1')).toBe('pl')
    expect(matchAcceptLanguage('*')).toBeNull()
    expect(matchAcceptLanguage('pl;q=0, en;q=0.1')).toBe('en')
    expect(matchAcceptLanguage('pl;q=0')).toBeNull()
  })

  it('survives malformed headers', () => {
    expect(matchAcceptLanguage(',,;q=1,;;,pl;q=abc,en')).toBe('en')
    expect(matchAcceptLanguage('   ')).toBeNull()
    expect(matchAcceptLanguage(undefined)).toBeNull()
    expect(matchAcceptLanguage(`${'x,'.repeat(5000)}pl`)).toBeNull()
  })
})
