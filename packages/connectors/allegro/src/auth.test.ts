import { AuthExpiredError, classifyConnectorError, isAllowedVerificationUri, PermanentError, RateLimitedError, TransientError } from '@hanza/connector-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { allegroAuth } from './auth'
import { PUBLIC_JSON, type AllegroAuthContext } from './client'
import { allegroCredentialsSchema, type AllegroCredentials } from './settings'

const CLIENT_ID = 'client-id-test-0001'
const CLIENT_SECRET = 'client-secret-test-0002'
const OLD_ACCESS = 'old-access-token-0003'
const OLD_REFRESH = 'old-refresh-token-0004'
const NEW_ACCESS = 'new-access-token-0005'
const NEW_REFRESH = 'new-refresh-token-0006'
const DEVICE_CODE = 'device-code-secret-0007'
const SECRETS = [CLIENT_ID, CLIENT_SECRET, OLD_ACCESS, OLD_REFRESH, NEW_ACCESS, NEW_REFRESH, DEVICE_CODE, btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)]
const NOW = new Date('2026-10-10T12:00:00.000Z')

interface Recorded {
  url: string
  method: string
  headers: Headers
  body: string | null
}

function stubFetch(...answers: ((call: Recorded) => Response)[]) {
  const calls: Recorded[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body === undefined || init.body === null ? null : String(init.body),
    }
    calls.push(call)
    const answer = answers[calls.length - 1]
    if (!answer) throw new Error(`unexpected request ${calls.length}`)
    return answer(call)
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

function context(fetch: typeof globalThis.fetch, environment: 'production' | 'sandbox' = 'production'): AllegroAuthContext {
  return { app: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, environment, appName: 'Hanza Test Shop' }, config: {}, fetch, log: () => {} }
}

const credentials: AllegroCredentials = { accessToken: OLD_ACCESS, refreshToken: OLD_REFRESH, accessTokenExpiresAt: '2026-10-10T11:00:00.000Z' }

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const tokens = () =>
  json({ access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, expires_in: 43199, scope: 'allegro:api:profile:read', jti: 'jti-1', token_type: 'bearer' })
const oauthError = (error: string, status = 400) => () => json({ error, error_description: `about ${OLD_REFRESH}` }, status)

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

function expectNoSecret(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  for (const secret of SECRETS) expect(message).not.toContain(secret)
}

function expectTokenRequest(call: Recorded | undefined, url: string, { form = true } = {}) {
  expect(call?.url).toBe(url)
  expect(call?.method).toBe('POST')
  expect(call?.headers.get('authorization')).toBe(`Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`)
  expect(call?.headers.get('accept')).toBe('application/json')
  expect(call?.headers.get('content-type')).toBe(form ? 'application/x-www-form-urlencoded' : null)
  expect(call?.headers.get('user-agent')).toBe('Hanza Test Shop/0.1.0 (+https://github.com/evelumo/hanza)')
}

const form = (call: Recorded | undefined) => Object.fromEntries(new URLSearchParams(call?.body ?? ''))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('allegroAuth', () => {
  it('is oauth2 and reads the expiry from the credentials', () => {
    expect(allegroAuth.type).toBe('oauth2')
    expect(allegroAuth.expiresAt?.(credentials)).toBe('2026-10-10T11:00:00.000Z')
  })

  it('allows verification links on both environments only', () => {
    const hosts = allegroAuth.deviceFlow?.verificationHosts ?? []
    expect(isAllowedVerificationUri('https://allegro.pl/skojarz-aplikacje?code=ABC', hosts)).toBe(true)
    expect(isAllowedVerificationUri('https://allegro.pl.allegrosandbox.pl/skojarz-aplikacje', hosts)).toBe(true)
    expect(isAllowedVerificationUri('https://allegro.pl.evil.example/skojarz-aplikacje', hosts)).toBe(false)
  })
})

describe('refresh', () => {
  const refresh = (fetch: typeof globalThis.fetch, environment?: 'production' | 'sandbox') => {
    if (!allegroAuth.refresh) throw new Error('no refresh')
    return allegroAuth.refresh(context(fetch, environment), credentials)
  }

  it('posts the refresh grant with Basic auth and returns rotated credentials', async () => {
    const { fetch, calls } = stubFetch(tokens)
    const refreshed = await refresh(fetch)
    expectTokenRequest(calls[0], 'https://allegro.pl/auth/oauth/token')
    expect(form(calls[0])).toEqual({ grant_type: 'refresh_token', refresh_token: OLD_REFRESH })
    expect(refreshed).toEqual({ accessToken: NEW_ACCESS, refreshToken: NEW_REFRESH, accessTokenExpiresAt: '2026-10-10T23:59:59.000Z' })
    expect(allegroCredentialsSchema.parse(refreshed)).toEqual(refreshed)
  })

  it('uses the sandbox OAuth host in the sandbox', async () => {
    const { fetch, calls } = stubFetch(tokens)
    await refresh(fetch, 'sandbox')
    expect(calls[0]?.url).toBe('https://allegro.pl.allegrosandbox.pl/auth/oauth/token')
  })

  it.each(['invalid_grant', 'invalid_token'])('asks for a new sign-in on 400 %s', async (code) => {
    const error = await failure(refresh(stubFetch(oauthError(code)).fetch))
    expect(error).toBeInstanceOf(AuthExpiredError)
    expect((error as Error).message).toBe(`400 ${code}`)
    expectNoSecret(error)
  })

  it('treats another OAuth 400 as permanent', async () => {
    const error = await failure(refresh(stubFetch(oauthError('unsupported_grant_type')).fetch))
    expect(error).toBeInstanceOf(PermanentError)
    expect(classifyConnectorError(error).kind).toBe('permanent')
    expect((error as Error).message).toBe('400 unsupported_grant_type')
  })

  it('treats a 400 without a plain OAuth error code as permanent, without echoing it', async () => {
    const error = await failure(refresh(stubFetch(oauthError(`bad ${OLD_REFRESH}`)).fetch))
    expect(error).toBeInstanceOf(PermanentError)
    expect((error as Error).message).toBe('400 Bad Request')
    expectNoSecret(error)
  })

  it.each([
    [401, 'permanent'],
    [403, 'permanent'],
    [429, 'rate_limited'],
    [500, 'transient'],
    [503, 'transient'],
  ] as const)('maps a token endpoint %i to %s', async (status, kind) => {
    const error = await failure(refresh(stubFetch(oauthError('unauthorized', status)).fetch))
    expect(classifyConnectorError(error).kind).toBe(kind)
    expectNoSecret(error)
  })

  it('fails on a token response of the wrong shape, naming paths only', async () => {
    const error = await failure(refresh(stubFetch(() => json({ access_token: NEW_ACCESS, expires_in: 'soon' })).fetch))
    expect(error).toBeInstanceOf(PermanentError)
    expect((error as Error).message).toBe('Unexpected token response: refresh_token, expires_in')
    expectNoSecret(error)
  })

  it('lets a ConnectorError from fetch through, and wraps a network failure', async () => {
    const limited = new RateLimitedError('limited', { retryAfterMs: 1000 })
    const throwing = (error: unknown) => (() => Promise.reject(error)) as typeof globalThis.fetch
    expect(await failure(refresh(throwing(limited)))).toBe(limited)
    const wrapped = await failure(refresh(throwing(new TypeError('fetch failed'))))
    expect(wrapped).toBeInstanceOf(TransientError)
  })
})

describe('device flow', () => {
  const flow = () => {
    if (!allegroAuth.deviceFlow) throw new Error('no device flow')
    return allegroAuth.deviceFlow
  }
  const device = {
    device_code: DEVICE_CODE,
    user_code: 'ABC DEF GHI',
    verification_uri: 'https://allegro.pl/skojarz-aplikacje',
    verification_uri_complete: 'https://allegro.pl/skojarz-aplikacje?code=ABCDEFGHI',
    expires_in: 3600,
    interval: 5,
  }

  describe('start', () => {
    it('posts the client id in the query with Basic auth, no body and no scope', async () => {
      const { fetch, calls } = stubFetch(() => json(device))
      const started = await flow().start(context(fetch))
      expectTokenRequest(calls[0], `https://allegro.pl/auth/oauth/device?client_id=${CLIENT_ID}`, { form: false })
      expect(calls[0]?.body).toBeNull()
      expect(new URL(calls[0]?.url ?? '').searchParams.has('scope')).toBe(false)
      expect(started).toEqual({
        deviceCode: DEVICE_CODE,
        userCode: 'ABC DEF GHI',
        verificationUri: 'https://allegro.pl/skojarz-aplikacje',
        verificationUriComplete: 'https://allegro.pl/skojarz-aplikacje?code=ABCDEFGHI',
        expiresInSeconds: 3600,
        intervalSeconds: 5,
      })
    })

    it('uses the sandbox OAuth host and accepts a missing complete link', async () => {
      const { fetch, calls } = stubFetch(() => json({ ...device, verification_uri: 'https://allegro.pl.allegrosandbox.pl/skojarz-aplikacje', verification_uri_complete: undefined }))
      const started = await flow().start(context(fetch, 'sandbox'))
      expect(calls[0]?.url).toBe(`https://allegro.pl.allegrosandbox.pl/auth/oauth/device?client_id=${CLIENT_ID}`)
      expect(started.verificationUriComplete).toBeNull()
    })

    it('fails on a response of the wrong shape, naming paths only', async () => {
      const error = await failure(flow().start(context(stubFetch(() => json({ ...device, verification_uri: 'not a url', interval: 0 })).fetch)))
      expect(error).toBeInstanceOf(PermanentError)
      expect((error as Error).message).toBe('Unexpected device authorization response: interval')
      const second = await failure(flow().start(context(stubFetch(() => json({ ...device, verification_uri: 'not a url' })).fetch)))
      expect((second as Error).message).toBe('Unexpected device authorization response: verificationUri')
      expectNoSecret(second)
    })

    it('maps an OAuth 400 to permanent, and a 401 (the application refused) to permanent naming the settings', async () => {
      const refused = await failure(flow().start(context(stubFetch(oauthError('invalid_client')).fetch)))
      expect(refused).toBeInstanceOf(PermanentError)
      expect((refused as Error).message).toBe('400 invalid_client')
      const unauthorized = await failure(flow().start(context(stubFetch(oauthError('unauthorized', 401)).fetch)))
      expect(unauthorized).toBeInstanceOf(PermanentError)
      expect((unauthorized as Error).message).toBe('401 Unauthorized: check the installation settings')
    })

    it('maps a token body that cannot be read to transient', async () => {
      const broken = () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new DOMException('The operation timed out', 'TimeoutError'))
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      const error = await failure(flow().poll(context(stubFetch(broken).fetch), DEVICE_CODE))
      expect(error).toBeInstanceOf(TransientError)
      expect((error as Error).cause).toMatchObject({ name: 'TimeoutError' })
    })
  })

  describe('poll', () => {
    it.each([
      ['authorization_pending', 'pending'],
      ['slow_down', 'slow_down'],
      ['access_denied', 'denied'],
      ['expired_token', 'expired'],
    ] as const)('maps 400 %s to %s', async (code, status) => {
      const { fetch, calls } = stubFetch(oauthError(code))
      expect(await flow().poll(context(fetch), DEVICE_CODE)).toEqual({ status })
      expectTokenRequest(calls[0], 'https://allegro.pl/auth/oauth/token')
      expect(form(calls[0])).toEqual({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: DEVICE_CODE })
      expect(calls).toHaveLength(1)
    })

    it('treats another OAuth 400 (an invalid or used device code) as permanent', async () => {
      const error = await failure(flow().poll(context(stubFetch(oauthError('invalid_grant')).fetch), DEVICE_CODE))
      expect(error).toBeInstanceOf(PermanentError)
      expect((error as Error).message).toBe('400 invalid_grant')
      expectNoSecret(error)
    })

    it('returns the credentials and the account from /me once approved', async () => {
      const { fetch, calls } = stubFetch(tokens, () =>
        json({ id: '46968690', login: 'test-seller', firstName: 'Jan', lastName: 'Kowalski', email: 'seller@example.com' }),
      )
      const result = await flow().poll(context(fetch), DEVICE_CODE)
      expect(result).toEqual({
        status: 'approved',
        credentials: { accessToken: NEW_ACCESS, refreshToken: NEW_REFRESH, accessTokenExpiresAt: '2026-10-10T23:59:59.000Z' },
        account: { id: '46968690', label: 'test-seller' },
      })
      const me = calls[1]
      expect(me?.url).toBe('https://api.allegro.pl/me')
      expect(me?.method).toBe('GET')
      expect(me?.headers.get('authorization')).toBe(`Bearer ${NEW_ACCESS}`)
      expect(me?.headers.get('accept')).toBe(PUBLIC_JSON)
      expect(me?.headers.get('user-agent')).toBe('Hanza Test Shop/0.1.0 (+https://github.com/evelumo/hanza)')
    })

    it('asks the sandbox API for the account in the sandbox', async () => {
      const { fetch, calls } = stubFetch(tokens, () => json({ id: '1', login: 'sandbox-seller' }))
      await flow().poll(context(fetch, 'sandbox'), DEVICE_CODE)
      expect(calls[0]?.url).toBe('https://allegro.pl.allegrosandbox.pl/auth/oauth/token')
      expect(calls[1]?.url).toBe('https://api.allegro.pl.allegrosandbox.pl/me')
    })

    it('fails, without a token in the message, when /me fails or answers the wrong shape', async () => {
      const unauthorized = await failure(flow().poll(context(stubFetch(tokens, oauthError('invalid_token', 401)).fetch), DEVICE_CODE))
      expect(unauthorized).toBeInstanceOf(AuthExpiredError)
      expectNoSecret(unauthorized)
      const unavailable = await failure(flow().poll(context(stubFetch(tokens, () => json({}, 503)).fetch), DEVICE_CODE))
      expect(unavailable).toBeInstanceOf(TransientError)
      expectNoSecret(unavailable)
      const shape = await failure(flow().poll(context(stubFetch(tokens, () => json({ id: 1 })).fetch), DEVICE_CODE))
      expect(shape).toBeInstanceOf(PermanentError)
      expect((shape as Error).message).toBe('Unexpected account response: id, login')
    })

    it('fails on a token response of the wrong shape, without asking /me', async () => {
      const { fetch, calls } = stubFetch(() => json({ access_token: NEW_ACCESS }))
      const error = await failure(flow().poll(context(fetch), DEVICE_CODE))
      expect(error).toBeInstanceOf(PermanentError)
      expectNoSecret(error)
      expect(calls).toHaveLength(1)
    })
  })
})
