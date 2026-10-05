import { DomainError, type DomainErrorCode } from '@hanza/core'

const messages: Record<DomainErrorCode, string> = {
  not_found: 'Nie znaleziono.',
  sku_taken: 'Produkt z tym SKU już istnieje.',
  invalid_transition: 'Tej zmiany statusu nie można wykonać.',
  unmatched_lines: 'Najpierw połącz wszystkie pozycje z produktami.',
  already_linked: 'Ta pozycja jest już połączona.',
  unknown_connector: 'Nieznany konektor.',
  invalid_config: 'Sprawdź poprawność pól.',
}

export const UNEXPECTED_ERROR_MESSAGE = 'Coś poszło nie tak. Spróbuj ponownie.'

export function domainErrorMessage(code: DomainErrorCode): string {
  return messages[code]
}

/** Polish text for the user; anything that is not a `DomainError` becomes a generic one, never its own message. */
export function errorMessage(error: unknown): { message: string; expected: boolean } {
  if (error instanceof DomainError) return { message: messages[error.code] ?? UNEXPECTED_ERROR_MESSAGE, expected: true }
  return { message: UNEXPECTED_ERROR_MESSAGE, expected: false }
}
