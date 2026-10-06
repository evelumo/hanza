import { z } from 'zod'

/**
 * What the sign-in hooks of an `oauth2` connector get: no credentials (they are the result), the
 * installation settings (`app`, e.g. the OAuth client id and secret) and the Connection's config.
 */
export interface AuthContext<TConfig = unknown, TApp = unknown> {
  /** Installation settings, parsed with `appConfigSchema`; `{}` when the connector declares none. Never log them. */
  app: TApp
  /** Non-secret settings of the Connection, parsed with `configSchema`. */
  config: TConfig
  /** Global fetch with a 30 s timeout added by the core. */
  fetch: typeof fetch
  log(message: string, fields?: Record<string, unknown>): void
}

export const deviceSignInStartSchema = z.object({
  /** Secret: the core seals it and never shows it. */
  deviceCode: z.string().min(1).max(4000),
  /** Shown to the person, who types it on the Channel's page. */
  userCode: z.string().min(1).max(100),
  verificationUri: z.url(),
  /** The verification page with the code filled in, if the Channel has one. */
  verificationUriComplete: z.url().nullable(),
  expiresInSeconds: z.number().int().positive().max(86_400),
  /** How long to wait between polls. */
  intervalSeconds: z.number().int().min(1).max(600),
})
export type DeviceSignInStart = z.infer<typeof deviceSignInStartSchema>

export const signedInAccountSchema = z.object({
  /** Stable id of the account on the Channel; "Sign in again" refuses a different one. */
  id: z.string().min(1).max(200),
  /** Shown in the panel, e.g. the seller's login. Not secret. */
  label: z.string().min(1).max(200),
})
export type SignedInAccount = z.infer<typeof signedInAccountSchema>

export const DEVICE_SIGN_IN_WAITING = ['pending', 'slow_down', 'denied', 'expired'] as const

export const deviceSignInPollSchema = z.union([
  z.object({ status: z.enum(DEVICE_SIGN_IN_WAITING) }),
  z.object({ status: z.literal('approved'), credentials: z.unknown(), account: signedInAccountSchema.nullable() }),
])

export type DeviceSignInPoll<TCredentials = unknown> =
  | { status: (typeof DEVICE_SIGN_IN_WAITING)[number] }
  | { status: 'approved'; credentials: TCredentials; account: SignedInAccount | null }

/**
 * OAuth 2.0 device authorization grant (RFC 8628), driven by the core: it calls `start` once, shows the
 * user code and the link, then calls `poll` every `intervalSeconds` until the person approves, denies or
 * the code expires.
 */
export interface DeviceFlow<TConfig = unknown, TCredentials = unknown, TApp = unknown> {
  start(ctx: AuthContext<TConfig, TApp>): Promise<DeviceSignInStart>
  /**
   * `pending`: not approved yet; `slow_down`: polled too often (the core adds 5 s to the interval);
   * `denied` / `expired`: the sign-in is over. `approved` carries the new credentials and, when the
   * Channel can tell, the account they belong to.
   */
  poll(ctx: AuthContext<TConfig, TApp>, deviceCode: string): Promise<DeviceSignInPoll<TCredentials>>
  /** Hosts the verification link may point to; the panel links only to `https:` URLs on one of them. */
  verificationHosts: readonly string[]
}

// Method syntax on purpose, as in `Capabilities`: definitions with specific types stay assignable to AnyConnectorDefinition.
export interface OAuth2Auth<TConfig = unknown, TCredentials = unknown, TApp = unknown> {
  type: 'oauth2'
  /**
   * Exchange the stored credentials for fresh ones (rotated refresh token included). The core decides
   * when, serialises refreshes per Connection and stores the result before any capability uses it
   * (ADR 0019). Throw `AuthExpiredError` when the refresh itself is refused.
   */
  refresh?(ctx: AuthContext<TConfig, TApp>, credentials: TCredentials): Promise<TCredentials>
  /** ISO time the access token in these credentials expires, or null if unknown. */
  expiresAt?(credentials: TCredentials): string | null
  /** Interactive sign-in for connectors whose Channel offers the device flow. */
  deviceFlow?: DeviceFlow<TConfig, TCredentials, TApp>
}

export type ConnectorAuth<TConfig = unknown, TCredentials = unknown, TApp = unknown> =
  | { type: 'apiKey' }
  | { type: 'none' }
  | OAuth2Auth<TConfig, TCredentials, TApp>

/** True when `uri` is an `https:` URL on one of `hosts` (exact host match, case-insensitive). */
export function isAllowedVerificationUri(uri: string | null | undefined, hosts: readonly string[]): boolean {
  if (!uri) return false
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return false
  const host = url.hostname.toLowerCase()
  return hosts.some((allowed) => allowed.toLowerCase() === host)
}
