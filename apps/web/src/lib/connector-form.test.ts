import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { describeFields, fieldErrorsFromIssues, issuesOf, readFields } from './connector-form'

const config = z.object({
  region: z.enum(['pl', 'de']).default('pl').describe('Region'),
  shopUrl: z.string().describe('Adres sklepu'),
  limit: z.number().int().optional(),
  ratio: z.number(),
  sandbox: z.boolean().default(false).describe('Tryb testowy'),
  note: z.string().nullable().optional(),
})

describe('describeFields', () => {
  const fields = describeFields('config', config)
  const byName = Object.fromEntries(fields.map((field) => [field.name, field]))

  it('maps types to controls and prefixes the names with the scope', () => {
    expect(byName['config.region']).toMatchObject({ control: 'select', options: ['pl', 'de'], defaultValue: 'pl', label: 'Region', required: false })
    expect(byName['config.shopUrl']).toMatchObject({ control: 'text', required: true, label: 'Adres sklepu' })
    expect(byName['config.limit']).toMatchObject({ control: 'number', integer: true, required: false, label: 'limit' })
    expect(byName['config.ratio']).toMatchObject({ control: 'number', integer: false, required: true })
    expect(byName['config.sandbox']).toMatchObject({ control: 'checkbox', defaultValue: false })
    expect(byName['config.note']).toMatchObject({ control: 'text', required: false })
  })

  it('renders every string of the credentials as a password input', () => {
    const credentials = describeFields('credentials', z.object({ apiKey: z.string().min(1).describe('Klucz API'), region: z.enum(['a', 'b']) }))
    expect(credentials.find((field) => field.name === 'credentials.apiKey')).toMatchObject({ control: 'password', label: 'Klucz API', required: true })
    expect(credentials.find((field) => field.name === 'credentials.region')?.control).toBe('select')
  })

  it('returns no fields for an empty or non-object schema', () => {
    expect(describeFields('credentials', z.object({}))).toEqual([])
    expect(describeFields('config', z.string())).toEqual([])
  })
})

describe('readFields', () => {
  const fields = describeFields('config', config)

  it('coerces by field type and leaves empty inputs out', () => {
    const form = new FormData()
    form.set('config.region', 'de')
    form.set('config.shopUrl', '  https://shop.example  ')
    form.set('config.limit', '25')
    form.set('config.ratio', '')
    form.set('config.sandbox', 'on')
    expect(readFields(fields, form)).toEqual({ region: 'de', shopUrl: 'https://shop.example', limit: 25, sandbox: true })
  })

  it('reads an unchecked checkbox as false and passes a bad number on as text for the schema to reject', () => {
    const form = new FormData()
    form.set('config.ratio', 'abc')
    expect(readFields(fields, form)).toEqual({ ratio: 'abc', sandbox: false })
  })

  it('ignores form fields that are not in the schema', () => {
    const form = new FormData()
    form.set('config.shopUrl', 'x')
    form.set('config.admin', 'true')
    form.set('credentials.apiKey', 'secret')
    expect(readFields(fields, form)).toEqual({ shopUrl: 'x', sandbox: false })
  })
})

describe('fieldErrorsFromIssues', () => {
  const fields = describeFields('config', config)

  it('tells a missing field from an invalid one, in Polish', () => {
    const form = new FormData()
    form.set('config.ratio', 'abc')
    const { fieldErrors, unmatched } = fieldErrorsFromIssues(
      fields,
      [
        { path: 'config.shopUrl', message: 'Invalid input: expected string, received undefined' },
        { path: 'config.ratio', message: 'Invalid input: expected number, received string' },
      ],
      form,
    )
    expect(fieldErrors).toEqual({ 'config.shopUrl': 'To pole jest wymagane.', 'config.ratio': 'Nieprawidłowa wartość.' })
    expect(unmatched).toBe(false)
  })

  it('flags issues that match no field', () => {
    expect(fieldErrorsFromIssues(fields, [{ path: 'config.unknown', message: 'x' }], new FormData()).unmatched).toBe(true)
  })
})

describe('issuesOf', () => {
  it('reads the issues of an invalid_config error and ignores anything else', () => {
    expect(issuesOf({ issues: [{ path: 'config.a', message: 'm' }, { nope: true }, 5] })).toEqual([{ path: 'config.a', message: 'm' }])
    expect(issuesOf(undefined)).toEqual([])
    expect(issuesOf({ issues: 'x' })).toEqual([])
  })
})
