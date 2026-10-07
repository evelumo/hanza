import type { AnyConnectorDefinition } from '@hanza/connector-sdk'
import { z } from 'zod'

/** A connector's installation settings: parsed, or the variables that are missing or invalid (names only, never values). */
export type ConnectorSettings = { ok: true; value: unknown } | { ok: false; variables: string[] }

export type SettingsSource = Readonly<Record<string, string | undefined>>

const PREFIX = 'HANZA_CONNECTOR_'

/** `fake-oauth` + `clientId` → `HANZA_CONNECTOR_FAKE_OAUTH_CLIENT_ID`. */
export function settingsVariable(connectorId: string, field: string): string {
  const id = connectorId.toUpperCase().replaceAll('-', '_')
  const name = field
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase()
  return `${PREFIX}${id}_${name}`
}

type JsonProperty = { type?: string; anyOf?: JsonProperty[] }

function fieldTypes(schema: z.ZodType): Map<string, string | undefined> {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as { properties?: Record<string, JsonProperty> }
  const types = new Map<string, string | undefined>()
  for (const [key, property] of Object.entries(json.properties ?? {})) {
    const member = property.anyOf?.find((candidate) => candidate.type !== 'null') ?? property
    types.set(key, member.type)
  }
  return types
}

// Environment values are strings; booleans and numbers are converted so the connector's schema sees real types.
function coerce(raw: string, type: string | undefined): unknown {
  if (type === 'boolean') {
    if (raw === 'true') return true
    if (raw === 'false') return false
    return raw
  }
  if ((type === 'number' || type === 'integer') && /^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
  return raw
}

/**
 * Reads the connector's `appConfigSchema` fields from `HANZA_CONNECTOR_<ID>_<FIELD>` only, so a connector
 * never sees another connector's settings. An empty variable counts as unset, so defaults apply.
 */
export function readConnectorSettings(connector: AnyConnectorDefinition, source: SettingsSource): ConnectorSettings {
  const schema = connector.appConfigSchema
  if (!schema) return { ok: true, value: {} }
  const types = fieldTypes(schema)
  const input: Record<string, unknown> = {}
  for (const [field, type] of types) {
    const raw = source[settingsVariable(connector.id, field)]?.trim()
    if (raw !== undefined && raw !== '') input[field] = coerce(raw, type)
  }
  const parsed = schema.safeParse(input)
  if (parsed.success) return { ok: true, value: parsed.data }
  const fields = new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? '')))
  // An issue on the whole object (a refinement) names no field: every variable may be the culprit.
  const known = [...fields].filter((field) => types.has(field))
  const named = fields.has('') || known.length === 0 ? [...types.keys()] : known
  return { ok: false, variables: named.map((field) => settingsVariable(connector.id, field)).sort() }
}
