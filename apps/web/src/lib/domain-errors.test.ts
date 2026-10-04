import { DomainError, type DomainErrorCode } from '@hanza/core'
import { describe, expect, it } from 'vitest'
import { UNEXPECTED_ERROR_MESSAGE, domainErrorMessage, errorMessage } from './domain-errors'

const codes: DomainErrorCode[] = ['not_found', 'sku_taken', 'invalid_transition', 'unmatched_lines', 'already_linked', 'unknown_connector', 'invalid_config']

describe('errorMessage', () => {
  it('has a Polish message for every DomainError code', () => {
    for (const code of codes) {
      const { message, expected } = errorMessage(new DomainError(code, 'internal english text'))
      expect(expected).toBe(true)
      expect(message).toBe(domainErrorMessage(code))
      expect(message).not.toContain('internal')
      expect(message).not.toBe(UNEXPECTED_ERROR_MESSAGE)
    }
  })

  it('uses the texts of the spec', () => {
    expect(domainErrorMessage('sku_taken')).toBe('Produkt z tym SKU już istnieje.')
    expect(domainErrorMessage('unmatched_lines')).toBe('Najpierw połącz wszystkie pozycje z produktami.')
    expect(domainErrorMessage('invalid_config')).toBe('Sprawdź poprawność pól.')
  })

  it('never shows the message of an unexpected error', () => {
    const secret = new Error('connect ECONNREFUSED 10.0.0.1:5432 password=hunter2')
    expect(errorMessage(secret)).toEqual({ message: UNEXPECTED_ERROR_MESSAGE, expected: false })
    expect(errorMessage('boom').message).toBe(UNEXPECTED_ERROR_MESSAGE)
    expect(errorMessage(undefined).expected).toBe(false)
  })
})
