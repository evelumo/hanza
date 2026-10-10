import type { CapabilityContext } from '@hanza/connector-sdk'
import { z } from 'zod'

// Names that only mean something inside the network the worker runs in.
const PRIVATE_SUFFIXES = ['localhost', 'local', 'internal', 'home.arpa']

/**
 * Whether a host can be a shop on the internet: a name of two labels or more, outside the suffixes kept for private
 * networks. No IP address, no `localhost`, no name without a dot (`wordpress`, `db`).
 *
 * Partial hardening only. The worker requests a host a member names, and a public name can still resolve to an
 * internal address, at once or later: the guard against internal destinations belongs where the connection is made,
 * in the core's `ctx.fetch`, and is tracked separately. This keeps the obvious ones out of the form.
 *
 * `hostname` is `URL.hostname`, so the parser has already lower-cased it, turned a unicode name into its ASCII form
 * (a full-width `ｌｏｃａｌｈｏｓｔ` is `localhost` here), and rewritten every way of writing an IPv4 address
 * (`2130706433`, `0x7f.1`, `127.1`) as four numbers.
 */
function isPublicHostname(hostname: string): boolean {
  // `localhost.` is `localhost`.
  const name = hostname.replace(/\.+$/, '')
  // An IPv6 address.
  if (name.startsWith('[')) return false
  const labels = name.split('.')
  if (labels.length < 2 || labels.includes('')) return false
  // An IPv4 address: no top-level domain is a number.
  if (/^\d+$/.test(labels.at(-1)!)) return false
  return !PRIVATE_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`))
}

/**
 * The shop's home address, as written: `https://`, a public host name, optionally a port and a path. Requests are
 * built from the parsed address (`apiUrl`), so whatever the parser would quietly repair or drop is refused here and
 * the address stored and shown is the one requests go to.
 *
 * - `https:` only: WooCommerce accepts API keys only over TLS, and the key travels in a header.
 * - No user name or password, and no `?` or `#`, also with nothing after it.
 * - No port 0, and a host that can be a shop (`isPublicHostname`).
 */
export function isStoreUrl(value: string): boolean {
  // The scheme and both slashes spelled out, and no space, control character or backslash anywhere.
  if (!/^https:\/\/[^\s\\?#\u0000-\u001f\u007f]+$/i.test(value)) return false
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return url.protocol === 'https:' && url.username === '' && url.password === '' && url.port !== '0' && isPublicHostname(url.hostname)
}

export const configSchema = z.object({
  storeUrl: z
    .string()
    .trim()
    .max(2000)
    .refine(isStoreUrl, { message: 'Use the public address of the shop starting with https://, without a user name, password or query' })
    .describe('Shop address (https://…)'),
})

// A key WooCommerce makes is 43 characters; the limit keeps what is pasted by mistake out of a request header.
const KEY_MAX_LENGTH = 255

export const credentialsSchema = z.object({
  consumerKey: z.string().trim().min(1).max(KEY_MAX_LENGTH).describe('Consumer key'),
  consumerSecret: z.string().trim().min(1).max(KEY_MAX_LENGTH).describe('Consumer secret'),
})

export type WooCommerceConfig = z.output<typeof configSchema>
export type WooCommerceCredentials = z.output<typeof credentialsSchema>
export type WooCommerceContext = CapabilityContext<WooCommerceConfig, WooCommerceCredentials>
