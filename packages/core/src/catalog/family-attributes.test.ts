import { describe, expect, it } from 'vitest'
import {
  isReservedAttributeName,
  MAX_ATTRIBUTE_NAME_LENGTH,
  MAX_ATTRIBUTE_VALUE_LENGTH,
  normalizeAttributeNames,
  normalizeAttributeValues,
  sameAttributeValues,
} from './family-attributes'

const invalid = { code: 'invalid_attributes' }

describe('normalizeAttributeNames', () => {
  it('trims and tidies names and keeps their order', () => {
    expect(normalizeAttributeNames(['  Size ', 'Colour  name'])).toEqual(['Size', 'Colour name'])
  })

  it('needs 1 to 5 names', () => {
    expect(() => normalizeAttributeNames([])).toThrowError(expect.objectContaining(invalid))
    expect(normalizeAttributeNames(['a', 'b', 'c', 'd', 'e'])).toHaveLength(5)
    expect(() => normalizeAttributeNames(['a', 'b', 'c', 'd', 'e', 'f'])).toThrowError(expect.objectContaining(invalid))
  })

  it('refuses empty, too long and duplicate names (ignoring case)', () => {
    expect(() => normalizeAttributeNames(['  '])).toThrowError(expect.objectContaining(invalid))
    expect(() => normalizeAttributeNames(['x'.repeat(MAX_ATTRIBUTE_NAME_LENGTH + 1)])).toThrowError(expect.objectContaining(invalid))
    expect(normalizeAttributeNames(['x'.repeat(MAX_ATTRIBUTE_NAME_LENGTH)])).toHaveLength(1)
    expect(() => normalizeAttributeNames(['Size', ' size '])).toThrowError(expect.objectContaining(invalid))
  })
})

describe('reserved attribute names', () => {
  it.each(['__proto__', 'constructor', 'prototype', ' __PROTO__ ', 'Constructor'])('refuses %j as an attribute name', (name) => {
    expect(isReservedAttributeName(name)).toBe(true)
    expect(() => normalizeAttributeNames(['Size', name])).toThrowError(expect.objectContaining(invalid))
  })

  it('still accepts ordinary names that merely contain one', () => {
    expect(normalizeAttributeNames(['constructor type', 'proto'])).toEqual(['constructor type', 'proto'])
  })
})

describe('Unicode normalisation', () => {
  const composed = 'Caf\u00e9'
  const decomposed = 'Cafe\u0301'

  it('treats composed and decomposed text as the same name', () => {
    expect(composed).not.toBe(decomposed)
    expect(normalizeAttributeNames([composed])).toEqual([composed])
    expect(normalizeAttributeNames([decomposed])).toEqual([composed])
    expect(() => normalizeAttributeNames([composed, decomposed])).toThrowError(expect.objectContaining(invalid))
  })

  it('gives composed and decomposed values the same key', () => {
    const a = normalizeAttributeValues(['Style'], { Style: composed })
    const b = normalizeAttributeValues(['Style'], { Style: decomposed })
    expect(a).toEqual(b)
    expect(a.values.Style).toBe(composed)
  })
})

describe('sameAttributeValues', () => {
  it('compares per attribute, whatever order the keys come in', () => {
    const attributes = ['Colour', 'Size']
    expect(sameAttributeValues(attributes, { Colour: 'Red', Size: 'M' }, { Size: 'M', Colour: 'Red' })).toBe(true)
    expect(sameAttributeValues(attributes, { Colour: 'Red', Size: 'M' }, { Size: 'M', Colour: 'red' })).toBe(false)
    expect(sameAttributeValues(attributes, { Colour: 'Red', Size: 'M' }, { Size: 'M' })).toBe(false)
  })
})

describe('normalizeAttributeValues', () => {
  const attributes = ['Size', 'Colour']

  it('refuses values that smuggle in a prototype key, without a TypeError', () => {
    const hostile = JSON.parse('{"Size":"M","Colour":"Red","__proto__":"x"}') as Record<string, string>
    expect(() => normalizeAttributeValues(attributes, hostile)).toThrowError(expect.objectContaining(invalid))
    expect(normalizeAttributeValues(['Size'], { Size: 'M' }).values).toEqual({ Size: 'M' })
  })

  it('keeps one tidy value per attribute and builds the key in attribute order', () => {
    expect(normalizeAttributeValues(attributes, { Colour: ' Dark  blue ', Size: 'M' })).toEqual({
      values: { Size: 'M', Colour: 'Dark blue' },
      key: '["m","dark blue"]',
    })
  })

  it('gives the same key to combinations that differ only in case and spacing', () => {
    const a = normalizeAttributeValues(attributes, { Size: 'M', Colour: 'Red' })
    const b = normalizeAttributeValues(attributes, { Size: ' m ', Colour: 'RED' })
    expect(a.key).toBe(b.key)
    expect(normalizeAttributeValues(attributes, { Size: 'L', Colour: 'Red' }).key).not.toBe(a.key)
  })

  it('does not let values run into each other', () => {
    expect(normalizeAttributeValues(attributes, { Size: 'a b', Colour: 'c' }).key).not.toBe(
      normalizeAttributeValues(attributes, { Size: 'a', Colour: 'b c' }).key,
    )
  })

  it('refuses a missing, empty, too long or unknown attribute', () => {
    expect(() => normalizeAttributeValues(attributes, { Size: 'M' })).toThrowError(expect.objectContaining(invalid))
    expect(() => normalizeAttributeValues(attributes, { Size: 'M', Colour: '  ' })).toThrowError(expect.objectContaining(invalid))
    expect(() => normalizeAttributeValues(attributes, { Size: 'M', Colour: 'x'.repeat(MAX_ATTRIBUTE_VALUE_LENGTH + 1) })).toThrowError(expect.objectContaining(invalid))
    expect(() => normalizeAttributeValues(attributes, { Size: 'M', Colour: 'Red', Material: 'Cotton' })).toThrowError(expect.objectContaining(invalid))
    expect(() => normalizeAttributeValues(attributes, { size: 'M', Colour: 'Red' })).toThrowError(expect.objectContaining(invalid))
  })
})
