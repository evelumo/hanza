import { z } from 'zod'

export const CONNECTOR_VERSION = '0.1.0'

export const ALLEGRO_ENVIRONMENTS = ['production', 'sandbox'] as const
export type AllegroEnvironment = (typeof ALLEGRO_ENVIRONMENTS)[number]

// Printable ASCII without spaces: these go into the Basic authorization header, which btoa and Headers refuse otherwise.
const ASCII_TOKEN = /^[\x21-\x7E]+$/
// Printable ASCII, no leading or trailing space: the name goes into the User-Agent header, which refuses anything else.
const HEADER_TEXT = /^[\x21-\x7E](?:[\x20-\x7E]*[\x21-\x7E])?$/

/**
 * Installation settings: the application the operator registered on Allegro, read by the core from
 * `HANZA_CONNECTOR_ALLEGRO_CLIENT_ID`, `_CLIENT_SECRET`, `_ENVIRONMENT` and `_APP_NAME`. Flat scalars only: the panel
 * draws a form from it and the conformance kit checks that.
 */
export const allegroAppConfigSchema = z.object({
  clientId: z.string().min(1).max(200).regex(ASCII_TOKEN).describe('Client ID'),
  clientSecret: z.string().min(1).max(500).regex(ASCII_TOKEN).describe('Client secret'),
  environment: z.enum(ALLEGRO_ENVIRONMENTS).default('production').describe('Environment'),
  // Must match the name registered with Allegro: their terms require it in the User-Agent.
  appName: z.string().min(1).max(100).regex(HEADER_TEXT).describe('Application name'),
})
export type AllegroApp = z.output<typeof allegroAppConfigSchema>

export const allegroConfigSchema = z.object({})
export type AllegroConfig = z.output<typeof allegroConfigSchema>

/** Written only by the core, after the device flow or a refresh; never drawn as a form. */
export const allegroCredentialsSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  accessTokenExpiresAt: z.iso.datetime({ offset: true }),
})
export type AllegroCredentials = z.output<typeof allegroCredentialsSchema>

export interface EnvironmentHosts {
  /** REST API base URL. */
  api: string
  /** OAuth base URL (`/device`, `/token`). */
  oauth: string
  /** The marketplace site, for Offer links. */
  site: string
  /** The host the device flow's verification link points to. */
  verificationHost: string
}

const HOSTS: Readonly<Record<AllegroEnvironment, Readonly<EnvironmentHosts>>> = Object.freeze({
  production: Object.freeze({
    api: 'https://api.allegro.pl',
    oauth: 'https://allegro.pl/auth/oauth',
    site: 'https://allegro.pl',
    verificationHost: 'allegro.pl',
  }),
  sandbox: Object.freeze({
    api: 'https://api.allegro.pl.allegrosandbox.pl',
    oauth: 'https://allegro.pl.allegrosandbox.pl/auth/oauth',
    site: 'https://allegro.pl.allegrosandbox.pl',
    verificationHost: 'allegro.pl.allegrosandbox.pl',
  }),
})

export function environmentHosts(environment: AllegroEnvironment): Readonly<EnvironmentHosts> {
  return HOSTS[environment]
}

/** Both environments' hosts: `deviceFlow.verificationHosts` is static, while the environment is an installation setting. */
export const VERIFICATION_HOSTS: readonly string[] = Object.freeze([HOSTS.production.verificationHost, HOSTS.sandbox.verificationHost])

/**
 * The scopes Hanza needs, for the operator registering the application. The device request sends no `scope`, so the
 * scopes registered with the application apply.
 */
export const OAUTH_SCOPES = Object.freeze([
  'allegro:api:orders:read',
  'allegro:api:orders:write',
  'allegro:api:sale:offers:read',
  'allegro:api:sale:offers:write',
  'allegro:api:profile:read',
] as const)

/** `AppName/Version (+URL)`, the form Allegro requires; only the version may change for a registered name. */
export function userAgent(app: Pick<AllegroApp, 'appName'>): string {
  return `${app.appName}/${CONNECTOR_VERSION} (+https://github.com/evelumo/hanza)`
}
