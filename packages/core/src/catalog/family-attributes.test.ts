import { describe, expect, it } from 'vitest'
import { MAX_ATTRIBUTE_NAME_LENGTH, MAX_ATTRIBUTE_VALUE_LENGTH, normalizeAttributeNames, normalizeAttributeValues } from './family-attributes'

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

describe('normalizeAttributeValues', () => {
  const attributes = ['Size', 'Colour']

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
