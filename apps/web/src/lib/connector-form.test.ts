import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { catalogues } from '@/i18n/catalogues'
import { translatorFor } from '@/i18n/testing'
import { describeFields, fieldErrorsFromIssues, issuesOf, publicValues, readFields } from './connector-form'

const config = z.object({
  region: z.enum(['pl', 'de']).default('pl').describe('Region'),
  shopUrl: z.string().describe('Shop URL'),
  limit: z.number().int().optional(),
  ratio: z.number(),
  sandbox: z.boolean().default(false).describe('Sandbox mode'),
  note: z.string().nullable().optional(),
})

describe('describeFields', () => {
  const fields = describeFields('config', config)
  const byName = Object.fromEntries(fields.map((field) => [field.name, field]))

  it('maps types to controls and prefixes the names with the scope', () => {
    expect(byName['config.region']).toMatchObject({ control: 'select', options: ['pl', 'de'], defaultValue: 'pl', label: 'Region', required: false })
    expect(byName['config.shopUrl']).toMatchObject({ control: 'text', required: true, label: 'Shop URL' })
    expect(byName['config.limit']).toMatchObject({ control: 'number', integer: true, required: false, label: 'limit' })
    expect(byName['config.ratio']).toMatchObject({ control: 'number', integer: false, required: true })
    expect(byName['config.sandbox']).toMatchObject({ control: 'checkbox', defaultValue: false })
    expect(byName['config.note']).toMatchObject({ control: 'text', required: false })
  })

  it('renders every string of the credentials as a password input', () => {
    const credentials = describeFields('credentials', z.object({ apiKey: z.string().min(1).describe('API key'), region: z.enum(['a', 'b']) }))
    expect(credentials.find((field) => field.name === 'credentials.apiKey')).toMatchObject({ control: 'password', label: 'API key', required: true })
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

  it('tells a missing field from an invalid one, in the language of the request', () => {
    const form = new FormData()
    form.set('config.ratio', 'abc')
    const { fieldErrors, unmatched } = fieldErrorsFromIssues(
      fields,
      [
        { path: 'config.shopUrl', message: 'Invalid input: expected string, received undefined' },
        { path: 'config.ratio', message: 'Invalid input: expected number, received string' },
      ],
      form,
      translatorFor('en'),
    )
    expect(fieldErrors).toEqual({ 'config.shopUrl': 'This field is required.', 'config.ratio': 'Invalid value.' })
    expect(unmatched).toBe(false)
    expect(fieldErrorsFromIssues(fields, [{ path: 'config.shopUrl', message: 'x' }], new FormData(), translatorFor('pl')).fieldErrors).toEqual({
      'config.shopUrl': catalogues.pl.validation.fieldRequired,
    })
  })

  it('flags issues that match no field', () => {
    expect(fieldErrorsFromIssues(fields, [{ path: 'config.unknown', message: 'x' }], new FormData(), translatorFor('en')).unmatched).toBe(true)
  })
})

describe('issuesOf', () => {
  it('reads the issues of an invalid_config error and ignores anything else', () => {
    expect(issuesOf({ issues: [{ path: 'config.a', message: 'm' }, { nope: true }, 5] })).toEqual([{ path: 'config.a', message: 'm' }])
    expect(issuesOf(undefined)).toEqual([])
    expect(issuesOf({ issues: 'x' })).toEqual([])
  })
})

describe('publicValues', () => {
  const configFields = describeFields('config', config)
  const credentialsFields = describeFields('credentials', z.object({ apiKey: z.string(), token: z.string().optional() }))
  const submitted = {
    connectorId: 'fake',
    name: 'Shop',
    'config.shopUrl': 'https://shop.example',
    'config.sandbox': 'on',
    'credentials.apiKey': 'sk-secret',
    'credentials.token': 'tok-secret',
    'config.undeclared': 'x',
    password: 'hunter2',
    organizationId: 'org-1',
  }

  it('echoes the base fields and the declared config fields only', () => {
    expect(publicValues(submitted, configFields)).toEqual({
      connectorId: 'fake',
      name: 'Shop',
      'config.shopUrl': 'https://shop.example',
      'config.sandbox': 'on',
    })
  })

  it('never echoes a credentials field, even when its fields are passed by mistake', () => {
    for (const fields of [configFields, [...configFields, ...credentialsFields], []]) {
      const echoed = JSON.stringify(publicValues(submitted, fields))
      expect(echoed).not.toContain('sk-secret')
      expect(echoed).not.toContain('tok-secret')
      expect(echoed).not.toContain('hunter2')
    }
  })

  it('echoes only the base fields before the connector is known', () => {
    expect(publicValues(submitted)).toEqual({ connectorId: 'fake', name: 'Shop' })
  })
})
