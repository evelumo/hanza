import { DomainError } from '../errors'

export const MAX_FAMILY_ATTRIBUTES = 5
export const MAX_ATTRIBUTE_NAME_LENGTH = 50
export const MAX_ATTRIBUTE_VALUE_LENGTH = 100

// NFC so that a composed and a decomposed "Café" are the same size, colour or name.
const tidy = (text: string): string => text.normalize('NFC').trim().replace(/\s+/g, ' ')

const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

/** Attribute names become keys of a plain object, so the ones that mean something to JavaScript objects are refused. */
export function isReservedAttributeName(name: string): boolean {
  return RESERVED_NAMES.has(tidy(name).toLowerCase())
}

/** Attribute names of a new family: trimmed, 1 to 5, unique ignoring case. */
export function normalizeAttributeNames(names: readonly string[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const name of names) {
    const tidied = tidy(name)
    if (!tidied || tidied.length > MAX_ATTRIBUTE_NAME_LENGTH || isReservedAttributeName(tidied)) throw new DomainError('invalid_attributes')
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
  const entries = attributes.map((name): [string, string] => {
    const value = Object.hasOwn(values, name) ? tidy(values[name] ?? '') : ''
    if (!value || value.length > MAX_ATTRIBUTE_VALUE_LENGTH) throw new DomainError('invalid_attributes')
    return [name, value]
  })
  // `fromEntries` defines own properties, so no name can reach the prototype.
  return { values: Object.fromEntries(entries), key: JSON.stringify(entries.map(([, value]) => value.toLowerCase())) }
}

/** Whether two sets of values for the same attributes are the same, whatever order the storage returns the keys in. */
export function sameAttributeValues(
  attributes: readonly string[],
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  return attributes.every((name) => a[name] === b[name])
}
