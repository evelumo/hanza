import { DomainError, type DomainErrorCode } from '@hanza/core'
import { describe, expect, it } from 'vitest'
import { catalogues } from '@/i18n/catalogues'
import { translatorFor } from '@/i18n/testing'
import { domainErrorMessage, errorMessage } from './domain-errors'

const codes: DomainErrorCode[] = ['not_found', 'sku_taken', 'invalid_transition', 'unmatched_lines', 'already_linked', 'unknown_connector', 'invalid_config', 'invalid_price']
const t = translatorFor('en')

describe('errorMessage', () => {
  it('has a message for every DomainError code, in both languages', () => {
    for (const locale of ['en', 'pl'] as const) {
      for (const code of codes) {
        const { message, expected } = errorMessage(new DomainError(code, 'internal english text'), translatorFor(locale))
        expect(expected).toBe(true)
        expect(message).toBe(catalogues[locale].errors.domain[code])
        expect(message).not.toContain('internal')
        expect(message).not.toBe(catalogues[locale].errors.unexpected)
      }
    }
  })

  it('uses the agreed English texts', () => {
    expect(domainErrorMessage(t, 'sku_taken')).toBe('A product with this SKU already exists.')
    expect(domainErrorMessage(t, 'unmatched_lines')).toBe('Link all the lines to products first.')
    expect(domainErrorMessage(translatorFor('pl'), 'sku_taken')).toBe(catalogues.pl.errors.domain.sku_taken)
    expect(catalogues.pl.errors.domain.sku_taken).not.toBe(catalogues.en.errors.domain.sku_taken)
  })

  it('never shows the message of an unexpected error', () => {
    const secret = new Error('connect ECONNREFUSED 10.0.0.1:5432 password=hunter2')
    expect(errorMessage(secret, t)).toEqual({ message: 'Something went wrong. Please try again.', expected: false })
    expect(errorMessage('boom', t).message).toBe('Something went wrong. Please try again.')
    expect(errorMessage(undefined, t).expected).toBe(false)
  })

  it('treats a DomainError code this build has no message for as unexpected', () => {
    const unknown = new DomainError('brand_new' as DomainErrorCode, 'x')
    expect(errorMessage(unknown, t)).toEqual({ message: 'Something went wrong. Please try again.', expected: false })
  })
})
