import { describe, expect, it } from 'vitest'
import { addToFamilySchema, attributeNamesSchema, createFamilySchema, parseAttributeValues, renameFamilySchema } from './schemas'
import { valueField } from './value-field'

describe('attributeNamesSchema', () => {
  it('splits on commas, tidies each name and drops empty ones', () => {
    expect(attributeNamesSchema.parse(' Size ,  Colour  name ,, ')).toEqual(['Size', 'Colour name'])
  })

  it.each(['', ' , ', 'a,b,c,d,e,f', 'Size, size', `${'x'.repeat(51)}`])('rejects %j', (text) => {
    expect(attributeNamesSchema.safeParse(text).success).toBe(false)
  })

  it.each(['__proto__', 'constructor', 'Size, prototype'])('rejects the reserved name in %j', (text) => {
    expect(attributeNamesSchema.safeParse(text).success).toBe(false)
  })

  it('accepts 5 names of 50 characters', () => {
    const names = ['a', 'b', 'c', 'd', 'e'].map((letter) => letter.repeat(50))
    expect(attributeNamesSchema.parse(names.join(','))).toEqual(names)
  })

  it('carries a message key', () => {
    const result = attributeNamesSchema.safeParse('')
    expect(result.success ? null : result.error.issues[0]?.message).toBe('validation.attributesInvalid')
  })
})

describe('family forms', () => {
  it('create needs a name and attributes', () => {
    expect(createFamilySchema.parse({ name: ' T-shirt ', attributes: 'Size, Colour' })).toEqual({ name: 'T-shirt', attributes: ['Size', 'Colour'] })
    expect(createFamilySchema.safeParse({ name: '', attributes: 'Size' }).success).toBe(false)
    expect(createFamilySchema.safeParse({ name: 'x'.repeat(101), attributes: 'Size' }).success).toBe(false)
    expect(createFamilySchema.safeParse({ name: 'x', attributes: '' }).success).toBe(false)
  })

  it('rename and add need ids and a SKU', () => {
    expect(renameFamilySchema.safeParse({ familyId: '', name: 'x' }).success).toBe(false)
    expect(addToFamilySchema.parse({ familyId: 'f', sku: ' SKU-1 ' })).toEqual({ familyId: 'f', sku: 'SKU-1' })
    expect(addToFamilySchema.safeParse({ familyId: 'f', sku: ' ' }).success).toBe(false)
  })
})

describe('parseAttributeValues', () => {
  const attributes = ['Size', 'Colour']

  it('reads one value per attribute from the numbered fields', () => {
    expect(parseAttributeValues(attributes, { [valueField(0)]: ' M ', [valueField(1)]: 'Red' })).toEqual({ ok: true, values: { Size: 'M', Colour: 'Red' } })
  })

  it('builds the values with own properties, whatever the attribute is called', () => {
    const parsed = parseAttributeValues(['__proto__'], { value0: 'M' })
    if (!parsed.ok) throw new Error('expected values')
    expect(Object.getPrototypeOf(parsed.values)).toBe(Object.prototype)
    expect(Object.keys(parsed.values)).toEqual(['__proto__'])
  })

  it('reports each empty, missing or too long field by its field name', () => {
    expect(parseAttributeValues(attributes, { value0: ' ', value1: 'x'.repeat(101) })).toEqual({
      ok: false,
      fieldErrors: { value0: 'validation.attributeValueRequired', value1: 'validation.attributeValueRequired' },
    })
    expect(parseAttributeValues(attributes, { value0: 'M' })).toMatchObject({ ok: false, fieldErrors: { value1: 'validation.attributeValueRequired' } })
  })
})
