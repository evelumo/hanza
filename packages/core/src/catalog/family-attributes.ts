import { DomainError } from '../errors'

export const MAX_FAMILY_ATTRIBUTES = 5
export const MAX_ATTRIBUTE_NAME_LENGTH = 50
export const MAX_ATTRIBUTE_VALUE_LENGTH = 100

const tidy = (text: string): string => text.trim().replace(/\s+/g, ' ')

/** Attribute names of a new family: trimmed, 1 to 5, unique ignoring case. */
export function normalizeAttributeNames(names: readonly string[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const name of names) {
    const tidied = tidy(name)
    if (!tidied || tidied.length > MAX_ATTRIBUTE_NAME_LENGTH) throw new DomainError('invalid_attributes')
    const folded = tidied.toLowerCase()
    if (seen.has(folded)) throw new DomainError('invalid_attributes')
    seen.add(folded)
    result.push(tidied)
  }
  if (result.length === 0 || result.length > MAX_FAMILY_ATTRIBUTES) throw new DomainError('invalid_attributes')
  return result
}

/**
 * The values a Product has for its family's attributes: exactly one non-empty value per attribute. `key` is what must be
 * unique within the family, so `M` and ` m ` are the same size.
 */
export function normalizeAttributeValues(
  attributes: readonly string[],
  values: Readonly<Record<string, string>>,
): { values: Record<string, string>; key: string } {
  const known = new Set(attributes)
  if (Object.keys(values).some((name) => !known.has(name))) throw new DomainError('invalid_attributes')
  const tidied: Record<string, string> = {}
  for (const name of attributes) {
    const value = Object.hasOwn(values, name) ? tidy(values[name] ?? '') : ''
    if (!value || value.length > MAX_ATTRIBUTE_VALUE_LENGTH) throw new DomainError('invalid_attributes')
    tidied[name] = value
  }
  return { values: tidied, key: JSON.stringify(attributes.map((name) => (tidied[name] as string).toLowerCase())) }
}
