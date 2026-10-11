import { PermanentError } from '@hanza/connector-sdk'
import { z } from 'zod'
import { formatProbeSchema, hanzaStatusSchema, WIRE_FORMAT, type HanzaStatus } from './api'
import { describeIssues, PLUGIN_NAME, request, type ClientContext } from './client'

// A version is shown in an error only when it looks like one: the text comes from a server a member named.
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/

function shown(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  return typeof value === 'string' && VERSION.test(value) ? `"${value}"` : 'an unknown one'
}

/**
 * The plugin's answer, checked for the wire format first: a plugin that speaks another format is refused by name,
 * before its fields are read as format 1's.
 */
export function readPluginAnswer<T extends z.ZodType>(raw: unknown, schema: T, what: string): z.output<T> {
  const probe = formatProbeSchema.safeParse(raw)
  if (!probe.success) throw new PermanentError(`Unexpected ${what} response from ${PLUGIN_NAME}: ${describeIssues(probe.error)}`)
  if (probe.data.format !== WIRE_FORMAT) {
    const version = probe.data.plugin?.version
    throw new PermanentError(
      `${PLUGIN_NAME}${version === undefined ? '' : ` ${shown(version)}`} speaks wire format ${shown(probe.data.format)}; ` +
        `this Hanza understands format ${WIRE_FORMAT}. Install a version of the plugin that speaks format ${WIRE_FORMAT}, or update Hanza`,
    )
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw new PermanentError(`Unexpected ${what} response from ${PLUGIN_NAME}: ${describeIssues(parsed.error)}`)
  return parsed.data
}

/**
 * `GET /admin/hanza/status`: the plugin's settings, the store's default currency and the journal's ends. The first
 * request of every call that needs the settings, which also lets the plugin stamp when Hanza last asked. A 404 is a
 * store without the plugin (`PLUGIN_MISSING_MESSAGE`).
 */
export async function readStatus(ctx: ClientContext): Promise<HanzaStatus> {
  const raw = await request(ctx, { path: 'hanza/status', schema: z.unknown(), what: 'plugin status' })
  return readPluginAnswer(raw, hanzaStatusSchema, 'plugin status')
}

/** The currency Offer prices are reported in: the plugin's setting, else the store's default; upper-cased, or null. */
export function offerCurrency(status: HanzaStatus): string | null {
  const code = status.settings.currency_code ?? status.store.default_currency_code ?? null
  if (code === null) return null
  const upper = code.trim().toUpperCase()
  return /^[A-Z]{3}$/.test(upper) ? upper : null
}
