import { z } from 'zod'

export type ConnectorFieldScope = 'config' | 'credentials'

export interface ConnectorField {
  /** Form field name, e.g. "config.failMode"; also the prefix `addConnection` puts on issue paths. */
  name: string
  label: string
  control: 'text' | 'password' | 'number' | 'checkbox' | 'select'
  required: boolean
  integer: boolean
  options: string[]
  defaultValue: string | number | boolean | null
}

type JsonSchema = {
  type?: string
  description?: string
  default?: unknown
  enum?: unknown[]
  anyOf?: JsonSchema[]
  properties?: Record<string, JsonSchema>
  required?: string[]
}

/** `z.string().nullable()` is `anyOf: [{ type: 'string' }, { type: 'null' }]`; use the first real member. */
function flatten(property: JsonSchema): JsonSchema {
  if (!property.anyOf) return property
  const member = property.anyOf.find((candidate) => candidate.type !== 'null') ?? {}
  return { ...member, description: property.description ?? member.description, default: property.default ?? member.default }
}

function defaultOf(value: unknown): ConnectorField['defaultValue'] {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : null
}

/**
 * Form fields for a connector's `configSchema` / `credentialsSchema` (a z.object of strings, numbers,
 * booleans and enums). Computed on the server both to render the form and to read it back, so the
 * browser never decides which fields exist.
 */
export function describeFields(scope: ConnectorFieldScope, schema: z.ZodType): ConnectorField[] {
  let json: JsonSchema
  try {
    json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema
  } catch {
    return []
  }
  const required = new Set(json.required ?? [])
  return Object.entries(json.properties ?? {}).map(([key, raw]) => {
    const property = flatten(raw)
    const options = Array.isArray(property.enum) ? property.enum.map(String) : []
    const control: ConnectorField['control'] =
      options.length > 0
        ? 'select'
        : property.type === 'boolean'
          ? 'checkbox'
          : property.type === 'number' || property.type === 'integer'
            ? 'number'
            : scope === 'credentials'
              ? 'password'
              : 'text'
    return {
      name: `${scope}.${key}`,
      label: property.description ?? key,
      control,
      required: required.has(key),
      integer: property.type === 'integer',
      options,
      defaultValue: defaultOf(property.default),
    }
  })
}

/** Reads the fields of one scope from the submitted form; empty inputs are left out so the schema reports them as missing. */
export function readFields(fields: ConnectorField[], formData: FormData): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const field of fields) {
    const key = field.name.slice(field.name.indexOf('.') + 1)
    if (field.control === 'checkbox') {
      result[key] = formData.has(field.name)
      continue
    }
    const raw = formData.get(field.name)
    const value = typeof raw === 'string' ? raw.trim() : ''
    if (value === '') continue
    if (field.control === 'number') {
      const parsed = Number(value)
      result[key] = Number.isFinite(parsed) ? parsed : value
    } else {
      result[key] = value
    }
  }
  return result
}

export const REQUIRED_FIELD_MESSAGE = 'To pole jest wymagane.'
export const INVALID_FIELD_MESSAGE = 'Nieprawidłowa wartość.'

/**
 * Maps the `invalid_config` issues of `addConnection` to Polish messages per form field. Connector
 * messages are English and not meant for users, so only "missing" and "invalid" are told apart.
 */
export function fieldErrorsFromIssues(
  fields: ConnectorField[],
  issues: Array<{ path: string; message: string }>,
  submitted: FormData,
): { fieldErrors: Record<string, string>; unmatched: boolean } {
  const byName = new Map(fields.map((field) => [field.name, field]))
  const fieldErrors: Record<string, string> = {}
  let unmatched = false
  for (const issue of issues) {
    const field = byName.get(issue.path.split('.').slice(0, 2).join('.'))
    if (!field) {
      unmatched = true
      continue
    }
    const raw = submitted.get(field.name)
    const empty = field.control !== 'checkbox' && (typeof raw !== 'string' || raw.trim() === '')
    fieldErrors[field.name] ??= empty ? REQUIRED_FIELD_MESSAGE : INVALID_FIELD_MESSAGE
  }
  return { fieldErrors, unmatched }
}

export function issuesOf(details: Record<string, unknown> | undefined): Array<{ path: string; message: string }> {
  const raw = details?.issues
  if (!Array.isArray(raw)) return []
  return raw.flatMap((issue) =>
    typeof issue === 'object' && issue !== null && typeof (issue as { path?: unknown }).path === 'string'
      ? [{ path: (issue as { path: string }).path, message: String((issue as { message?: unknown }).message ?? '') }]
      : [],
  )
}
