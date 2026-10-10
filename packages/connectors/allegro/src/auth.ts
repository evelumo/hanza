import {
  AuthExpiredError,
  deviceSignInStartSchema,
  errorFromResponse,
  PermanentError,
  signedInAccountSchema,
  type DeviceSignInPoll,
  type DeviceSignInStart,
  type OAuth2Auth,
} from '@hanza/connector-sdk'
import { deviceAuthorizationSchema, meSchema, tokenResponseSchema, type TokenResponse } from './api/auth'
import { oauthErrorSchema } from './api/errors'
import { fetchAllegro, issuePaths, parse, readJson, send, type AllegroAuthContext } from './client'
import {
  environmentHosts,
  userAgent,
  VERIFICATION_HOSTS,
  type AllegroApp,
  type AllegroConfig,
  type AllegroCredentials,
} from './settings'

const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
// An OAuth error code goes into an error message, so only a plain code does.
const OAUTH_ERROR = /^[A-Za-z0-9_.:-]{1,100}$/
// The token endpoint's refusals of a refresh token: the person has to sign in again.
const REFRESH_REFUSED = new Set(['invalid_grant', 'invalid_token'])

type TokenEndpointResult = { ok: true; body: unknown } | { ok: false; error: string }

/**
 * A request to the OAuth server with the application's client authentication (Basic). A 400 carrying an OAuth error
 * code is returned for the caller to read (the device flow speaks in them); every other failure throws.
 */
async function tokenEndpoint(
  ctx: AllegroAuthContext,
  endpoint: 'device' | 'token',
  params: { query?: Record<string, string>; form?: Record<string, string> },
): Promise<TokenEndpointResult> {
  const url = new URL(`${environmentHosts(ctx.app.environment).oauth}/${endpoint}`)
  for (const [name, value] of Object.entries(params.query ?? {})) url.searchParams.append(name, value)
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': userAgent(ctx.app),
    authorization: `Basic ${btoa(`${ctx.app.clientId}:${ctx.app.clientSecret}`)}`,
  }
  if (params.form) headers['content-type'] = 'application/x-www-form-urlencoded'
  const response = await fetchAllegro(ctx, url.toString(), {
    method: 'POST',
    headers,
    ...(params.form ? { body: new URLSearchParams(params.form) } : {}),
  })
  if (response.ok) return { ok: true, body: await readJson(response, 'OAuth') }
  if (response.status === 400) {
    const parsed = oauthErrorSchema.safeParse(await readJson(response, 'OAuth'))
    if (parsed.success && OAUTH_ERROR.test(parsed.data.error)) return { ok: false, error: parsed.data.error }
    throw new PermanentError('400 Bad Request')
  }
  // The token endpoint refuses the application, not the seller: a wrong client id or secret. Signing in again cannot help.
  if (response.status === 401) {
    await response.body?.cancel().catch(() => {})
    throw new PermanentError('401 Unauthorized: check the installation settings')
  }
  throw await errorFromResponse(response)
}

function credentialsFrom(body: unknown): AllegroCredentials {
  const parsed = tokenResponseSchema.safeParse(body)
  if (!parsed.success) throw new PermanentError(`Unexpected token response: ${issuePaths(parsed.error)}`)
  return toCredentials(parsed.data)
}

function toCredentials(tokens: TokenResponse): AllegroCredentials {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  }
}

async function start(ctx: AllegroAuthContext): Promise<DeviceSignInStart> {
  // `client_id` in the query and no body, as in Allegro's tutorial. No `scope`: the application's registered scopes apply (see OAUTH_SCOPES).
  const result = await tokenEndpoint(ctx, 'device', { query: { client_id: ctx.app.clientId } })
  if (!result.ok) throw new PermanentError(`400 ${result.error}`)
  const device = deviceAuthorizationSchema.safeParse(result.body)
  if (!device.success) throw new PermanentError(`Unexpected device authorization response: ${issuePaths(device.error)}`)
  const started = deviceSignInStartSchema.safeParse({
    deviceCode: device.data.device_code,
    userCode: device.data.user_code,
    verificationUri: device.data.verification_uri,
    verificationUriComplete: device.data.verification_uri_complete ?? null,
    expiresInSeconds: device.data.expires_in,
    intervalSeconds: device.data.interval,
  })
  if (!started.success) throw new PermanentError(`Unexpected device authorization response: ${issuePaths(started.error)}`)
  return started.data
}

async function poll(ctx: AllegroAuthContext, deviceCode: string): Promise<DeviceSignInPoll<AllegroCredentials>> {
  const result = await tokenEndpoint(ctx, 'token', { form: { grant_type: DEVICE_CODE_GRANT, device_code: deviceCode } })
  if (!result.ok) {
    switch (result.error) {
      case 'authorization_pending':
        return { status: 'pending' }
      case 'slow_down':
        return { status: 'slow_down' }
      case 'access_denied':
        return { status: 'denied' }
      case 'expired_token':
        return { status: 'expired' }
      // An invalid or already used device code answers 400 with a non-standard error text: the sign-in cannot go on.
      default:
        throw new PermanentError(`400 ${result.error}`)
    }
  }
  const credentials = credentialsFrom(result.body)
  const me = await parse(await send({ ...ctx, credentials }, '/me'), meSchema, 'account')
  const account = signedInAccountSchema.safeParse({ id: me.id, label: me.login })
  if (!account.success) throw new PermanentError(`Unexpected account response: ${issuePaths(account.error)}`)
  return { status: 'approved', credentials, account: account.data }
}

async function refresh(ctx: AllegroAuthContext, credentials: AllegroCredentials): Promise<AllegroCredentials> {
  const result = await tokenEndpoint(ctx, 'token', { form: { grant_type: 'refresh_token', refresh_token: credentials.refreshToken } })
  if (!result.ok) {
    if (REFRESH_REFUSED.has(result.error)) throw new AuthExpiredError(`400 ${result.error}`)
    throw new PermanentError(`400 ${result.error}`)
  }
  return credentialsFrom(result.body)
}

/**
 * Allegro's OAuth: the device flow to sign in, and refresh with a rotating refresh token. The core decides when to
 * refresh and stores the result (ADR 0020); token requests go through the same rate-limited `ctx.fetch` as the API.
 */
export const allegroAuth: OAuth2Auth<AllegroConfig, AllegroCredentials, AllegroApp> = {
  type: 'oauth2',
  expiresAt: (credentials) => credentials.accessTokenExpiresAt,
  refresh,
  deviceFlow: {
    verificationHosts: VERIFICATION_HOSTS,
    start,
    poll,
  },
}
