import type { CapabilityContext } from '@hanza/connector-sdk'
import { z } from 'zod'

// Duplicated from the WooCommerce connector (`packages/connectors/woocommerce/src/settings.ts`) on purpose: connectors
// may not import each other, and the shared guard belongs in the core's `ctx.fetch` (issue #136). Keep the two in step
// until it lands there, then delete both.

// Names that only mean something inside the network the worker runs in.
const PRIVATE_SUFFIXES = ['localhost', 'local', 'internal', 'home.arpa']

/**
 * Whether a host can be a store on the internet: a name of two labels or more, outside the suffixes kept for private
 * networks. No IP address, no `localhost`, no name without a dot (`medusa`, `db`).
 *
 * Partial hardening only. The worker requests a host a member names, and a public name can still resolve to an
 * internal address: the guard against internal destinations belongs where the connection is made (#136). This keeps
 * the obvious ones out of the form.
 *
 * `hostname` is `URL.hostname`, so the parser has already lower-cased it, turned a unicode name into its ASCII form and
 * rewritten every way of writing an IPv4 address as four numbers.
 */
function isPublicHostname(hostname: string): boolean {
  const name = hostname.replace(/\.+$/, '')
  if (name.startsWith('[')) return false
  const labels = name.split('.')
  if (labels.length < 2 || labels.includes('')) return false
  if (/^\d+$/.test(labels.at(-1)!)) return false
  return !PRIVATE_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`))
}

/**
 * The Medusa backend's address, as written: `https://`, a public host name, optionally a port and a path. Requests are
 * built from the parsed address (`apiUrl`), so whatever the parser would quietly repair or drop is refused here.
 *
 * - `https:` only: the secret API key travels in a header.
 * - No user name or password, and no `?` or `#`, also with nothing after it.
 * - No port 0, and a host that can be a store (`isPublicHostname`).
 */
export function isStoreUrl(value: string): boolean {
  if (!/^https:\/\/[^\s\\?#\u0000-\u001f\u007f]+$/i.test(value)) return false
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return url.protocol === 'https:' && url.username === '' && url.password === '' && url.port !== '0' && isPublicHostname(url.hostname)
}

export const medusaConfigSchema = z.object({
  storeUrl: z
    .string()
    .trim()
    .max(2000)
    .refine(isStoreUrl, { message: 'Use the public address of the Medusa backend starting with https://, without a user name, password or query' })
    .describe('Medusa backend address (https://…)'),
})

// A Medusa secret key is `sk_` and 64 hex characters; the limit keeps what is pasted by mistake out of a request header.
const KEY_MAX_LENGTH = 255

export const medusaCredentialsSchema = z.object({
  apiKey: z
    .string()
    .trim()
    .min(1)
    .max(KEY_MAX_LENGTH)
    // A header value: no whitespace or control characters inside it.
    .regex(/^[\x21-\x7e]+$/)
    .describe('Secret API key'),
})

export type MedusaConfig = z.output<typeof medusaConfigSchema>
export type MedusaCredentials = z.output<typeof medusaCredentialsSchema>
export type MedusaContext = CapabilityContext<MedusaConfig, MedusaCredentials>
