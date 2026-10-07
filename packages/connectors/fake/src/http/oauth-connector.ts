import {
  AuthExpiredError,
  defineConnector,
  errorFromResponse,
  PermanentError,
  TransientError,
  type AuthContext,
  type ConnectorDefinition,
  type DeviceSignInPoll,
  type Offer,
  type OrderPhase,
} from '@hanza/connector-sdk'
import { z } from 'zod'
import { API_STATUSES, offersPageSchema, ordersPageSchema } from './api'
import { FAKE_HTTP_BASE_URL, fakeHttpConfigSchema, mapOrder, parse, send, type HttpContext } from './connector'

/** Installation settings: the OAuth application the operator registered (`HANZA_CONNECTOR_FAKE_HTTP_OAUTH_*`). */
export const fakeHttpOAuthAppSchema = z.object({
  clientId: z.string().min(1).describe('Client ID'),
  clientSecret: z.string().min(1).describe('Client secret'),
})

export const fakeHttpOAuthCredentialsSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  accessTokenExpiresAt: z.iso.datetime({ offset: true }),
})

export type FakeHttpOAuthConnector = ConnectorDefinition<
  typeof fakeHttpConfigSchema,
  typeof fakeHttpOAuthCredentialsSchema,
  typeof fakeHttpOAuthAppSchema
>

type App = z.output<typeof fakeHttpOAuthAppSchema>
type Credentials = z.output<typeof fakeHttpOAuthCredentialsSchema>
type Auth = AuthContext<z.output<typeof fakeHttpConfigSchema>, App>

const tokensSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1), expires_in: z.number().int().positive() })
const oauthErrorSchema = z.object({ error: z.string() })
const deviceSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string(),
  verification_uri_complete: z.string().nullable(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive(),
})
const meSchema = z.object({ id: z.string().min(1), login: z.string().min(1) })

const toCredentials = (tokens: z.output<typeof tokensSchema>): Credentials => ({
  accessToken: tokens.access_token,
  refreshToken: tokens.refresh_token,
  accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
})

/** A token-endpoint call with client authentication (Basic), as Allegro's device flow and refresh do. */
async function tokenEndpoint(ctx: Auth, path: string, form: Record<string, string>): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  let response: Response
  try {
    response = await ctx.fetch(new URL(path, ctx.config.baseUrl), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${btoa(`${ctx.app.clientId}:${ctx.app.clientSecret}`)}`,
      },
      body: new URLSearchParams(form),
    })
  } catch (error) {
    throw new TransientError('The fake Channel could not be reached', { cause: error })
  }
  if (response.ok) return { ok: true, body: await response.json().catch(() => undefined) }
  if (response.status === 400) {
    const parsed = oauthErrorSchema.safeParse(await response.json().catch(() => undefined))
    if (parsed.success) return { ok: false, error: parsed.data.error }
    throw new PermanentError('400 Bad Request')
  }
  throw await errorFromResponse(response)
}

function tokens(body: unknown): Credentials {
  const parsed = tokensSchema.safeParse(body)
  if (!parsed.success) throw new PermanentError(`Unexpected token response: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`)
  return toCredentials(parsed.data)
}

/**
 * The fake Channel over HTTP with a real OAuth life cycle (device flow, short-lived access tokens, rotating refresh
 * tokens, application credentials as installation settings), shaped like Allegro's. Not registered: it exists to show
 * a connector with `appConfigSchema`, `auth.refresh` and `auth.deviceFlow` tested with recorded fixtures.
 */
export function createFakeHttpOAuthConnector(id = 'fake-http-oauth'): FakeHttpOAuthConnector {
  const bearer = (ctx: HttpContext & { credentials: Credentials }) => ({ authorization: `Bearer ${ctx.credentials.accessToken}` })
  return defineConnector({
    id,
    name: 'Test channel (HTTP, OAuth)',
    kind: 'marketplace',
    appConfigSchema: fakeHttpOAuthAppSchema,
    configSchema: fakeHttpConfigSchema,
    credentialsSchema: fakeHttpOAuthCredentialsSchema,
    auth: {
      type: 'oauth2',
      expiresAt: (credentials) => credentials.accessTokenExpiresAt,
      async refresh(ctx, credentials) {
        const result = await tokenEndpoint(ctx, '/oauth/token', { grant_type: 'refresh_token', refresh_token: credentials.refreshToken })
        if (!result.ok) {
          if (result.error === 'invalid_grant') throw new AuthExpiredError('400 invalid_grant')
          throw new PermanentError(`400 ${result.error}`)
        }
        return tokens(result.body)
      },
      deviceFlow: {
        verificationHosts: [new URL(FAKE_HTTP_BASE_URL).hostname],
        async start(ctx) {
          const result = await tokenEndpoint(ctx, '/oauth/device', { client_id: ctx.app.clientId })
          const parsed = deviceSchema.safeParse(result.ok ? result.body : undefined)
          if (!parsed.success) throw new PermanentError('Unexpected device authorization response')
          const device = parsed.data
          return {
            deviceCode: device.device_code,
            userCode: device.user_code,
            verificationUri: device.verification_uri,
            verificationUriComplete: device.verification_uri_complete,
            expiresInSeconds: device.expires_in,
            intervalSeconds: device.interval,
          }
        },
        async poll(ctx, deviceCode): Promise<DeviceSignInPoll<Credentials>> {
          const result = await tokenEndpoint(ctx, '/oauth/token', {
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: deviceCode,
          })
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
              default:
                throw new PermanentError(`400 ${result.error}`)
            }
          }
          const credentials = tokens(result.body)
          const me = await parse(await send(ctx, '/me', { headers: { authorization: `Bearer ${credentials.accessToken}` } }), meSchema, 'account')
          return { status: 'approved', credentials, account: { id: me.id, label: me.login } }
        },
      },
    },
    capabilities: {
      async 'offers.pull'(ctx, cursor) {
        const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`
        const page = await parse(await send(ctx, `/offers${query}`, { headers: bearer(ctx) }), offersPageSchema, 'offers')
        const items: Offer[] = page.offers.map((offer) => ({ externalId: offer.id, sku: offer.sku, name: offer.title, url: null, price: offer.price }))
        return { items, nextCursor: page.cursor, hasMore: page.more }
      },
      async 'orders.pull'(ctx, cursor) {
        const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`
        const page = await parse(await send(ctx, `/orders${query}`, { headers: bearer(ctx) }), ordersPageSchema, 'orders')
        return { items: page.orders.map(mapOrder), nextCursor: page.cursor, hasMore: page.more }
      },
      async 'stock.push'(ctx, levels) {
        if (levels.length === 0) return
        const items = levels.map((level) => ({ offerId: level.offerExternalId, sku: level.sku, quantity: level.available }))
        await send(ctx, '/stock', { method: 'PUT', headers: { ...bearer(ctx), 'content-type': 'application/json' }, body: JSON.stringify({ items }) })
      },
      async 'orders.updateStatus'(ctx, input: { orderExternalId: string; phase: OrderPhase }) {
        await send(ctx, `/orders/${encodeURIComponent(input.orderExternalId)}/status`, {
          method: 'PUT',
          headers: { ...bearer(ctx), 'content-type': 'application/json' },
          body: JSON.stringify({ status: API_STATUSES[input.phase] }),
        })
      },
    },
  })
}
