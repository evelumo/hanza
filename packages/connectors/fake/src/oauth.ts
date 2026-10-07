import {
  AuthExpiredError,
  PermanentError,
  TransientError,
  defineConnector,
  type CapabilityContext,
  type CapabilityName,
  type ConnectorDefinition,
  type SignedInAccount,
} from '@hanza/connector-sdk'
import { z } from 'zod'
import { createFakeChannel, type FakeChannel } from './channel'

/** Installation settings: `HANZA_CONNECTOR_FAKE_OAUTH_CLIENT_ID`, `_CLIENT_SECRET` and, optionally, `_POLL_INTERVAL_SECONDS`. */
export const fakeOAuthAppSchema = z.object({
  clientId: z.string().min(1).describe('Client ID'),
  clientSecret: z.string().min(1).describe('Client secret'),
  pollIntervalSeconds: z.number().int().min(1).max(60).default(5).describe('Device-flow poll interval'),
})

export const fakeOAuthConfigSchema = z.object({})

/** Written only by the core, from a sign-in or a refresh; never typed into a form. */
export const fakeOAuthCredentialsSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  accessTokenExpiresAt: z.iso.datetime({ offset: true }),
})

export type FakeOAuthCredentials = z.output<typeof fakeOAuthCredentialsSchema>
export type FakeOAuthConnector = ConnectorDefinition<typeof fakeOAuthConfigSchema, typeof fakeOAuthCredentialsSchema, typeof fakeOAuthAppSchema>

/** What `auth.refresh` does: rotate the pair, refuse it for good (`AuthExpiredError`), or fail for now (`TransientError`). */
export type FakeRefreshBehaviour = 'rotate' | 'fail_permanent' | 'fail_transient'

export interface FakeOAuthOptions {
  refreshBehaviour: FakeRefreshBehaviour
  /** Lifetime of every access token issued from now on. Default one hour. */
  accessTokenLifetimeMs: number
  /** Delay inside `auth.refresh`, so concurrent refreshes overlap in tests. Default 0. */
  refreshDelayMs: number
  /** Lifetime of a device code. Default 600 s. */
  deviceCodeLifetimeSeconds: number
  /** Every new device sign-in is approved at once, as the default account. Default false. */
  autoApprove: boolean
  /** False: an approval does not say which account approved (`account: null`), as some Channels cannot. Default true. */
  reportAccount: boolean
}

export const FAKE_OAUTH_VERIFICATION_HOST = 'fake-oauth.hanza.test'
export const FAKE_OAUTH_DEFAULT_ACCOUNT: SignedInAccount = { id: 'fake-seller-1', label: 'fake-seller' }

type Device = {
  userCode: string
  status: 'pending' | 'approved' | 'denied'
  account: SignedInAccount
  expiresAt: number
  slowDown: boolean
  used: boolean
}

export interface FakeOAuthChannel {
  connector: FakeOAuthConnector
  /** The Offers and Orders behind the sign-in (a plain fake Channel): add Orders, read stock pushes. */
  data: FakeChannel
  options: FakeOAuthOptions
  /** Every `auth.refresh` call, in order, with the refresh token it got and what it did. */
  readonly refreshes: Array<{ refreshToken: string; outcome: 'rotated' | 'refused' | 'failed' }>
  /** Every capability call with the access token it used, in order. */
  readonly tokenUses: Array<{ capability: CapabilityName; accessToken: string; accepted: boolean }>
  /** Client ids the connector was called with (installation settings reach it). */
  readonly clientIds: string[]
  /** Approves a pending device sign-in as `account` (default `FAKE_OAUTH_DEFAULT_ACCOUNT`); spaces in the code are ignored. */
  approve(userCode: string, account?: SignedInAccount): void
  deny(userCode: string): void
  /** The next poll of this code answers `slow_down`. */
  slowDown(userCode: string): void
  /** User codes still waiting for a decision. */
  pendingUserCodes(): string[]
  /** Credentials as if the account had signed in, for tests that create a Connection directly. */
  issueCredentials(account?: SignedInAccount): FakeOAuthCredentials
  /** The Channel stops accepting every access token issued so far (their expiry times stay as stored). */
  expireAccessTokens(): void
  /** The seller unlinked the application: every token issued so far is refused, refresh tokens included. */
  revokeAll(): void
  /** The account an access token belongs to, if it is one the fake issued. */
  accountOf(accessToken: string): string | undefined
  reset(): void
}

function normalise(userCode: string): string {
  return userCode.replace(/[\s-]/g, '').toUpperCase()
}

function randomUserCode(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const bytes = crypto.getRandomValues(new Uint8Array(9))
  return [...bytes].map((byte) => letters[byte % letters.length]).join('')
}

const defaults = (): FakeOAuthOptions => ({
  refreshBehaviour: 'rotate',
  accessTokenLifetimeMs: 3_600_000,
  refreshDelayMs: 0,
  deviceCodeLifetimeSeconds: 600,
  autoApprove: false,
  reportAccount: true,
})

/**
 * A fake Channel that signs in with OAuth: the device flow, short-lived access tokens and rotating refresh tokens,
 * all in memory. `id` other than "fake-oauth" registers an independent one next to it.
 */
export function createFakeOAuthChannel(options: { id?: string } = {}): FakeOAuthChannel {
  const data = createFakeChannel({ id: `${options.id ?? 'fake-oauth'}-data` })
  const accessTokens = new Map<string, { accountId: string; expiresAt: number; valid: boolean }>()
  const refreshTokens = new Map<string, { accountId: string; valid: boolean }>()
  const devices = new Map<string, Device>()
  const refreshes: FakeOAuthChannel['refreshes'] = []
  const tokenUses: FakeOAuthChannel['tokenUses'] = []
  const clientIds: string[] = []

  const issue = (account: SignedInAccount): FakeOAuthCredentials => {
    const accessToken = `fake-access-${crypto.randomUUID()}`
    const refreshToken = `fake-refresh-${crypto.randomUUID()}`
    const expiresAt = Date.now() + channel.options.accessTokenLifetimeMs
    accessTokens.set(accessToken, { accountId: account.id, expiresAt, valid: true })
    refreshTokens.set(refreshToken, { accountId: account.id, valid: true })
    return { accessToken, refreshToken, accessTokenExpiresAt: new Date(expiresAt).toISOString() }
  }

  const findDevice = (userCode: string): Device => {
    const wanted = normalise(userCode)
    const device = [...devices.values()].find((candidate) => candidate.userCode === wanted)
    if (!device) throw new Error(`No device sign-in with user code "${userCode}"`)
    return device
  }

  type Ctx = CapabilityContext<z.output<typeof fakeOAuthConfigSchema>, FakeOAuthCredentials, z.output<typeof fakeOAuthAppSchema>>
  // The data behind the sign-in is a plain fake Channel; its connector is called with dummy credentials.
  const inner = data.connector.capabilities
  const innerContext = (ctx: Ctx) => ({ app: {}, config: { failMode: 'none' as const, rejectOffers: '' }, credentials: { apiKey: 'inner' }, fetch: ctx.fetch, log: ctx.log })

  const authorise = (ctx: Ctx, capability: CapabilityName) => {
    clientIds.push(ctx.app.clientId)
    const token = accessTokens.get(ctx.credentials.accessToken)
    const accepted = token !== undefined && token.valid && token.expiresAt > Date.now()
    tokenUses.push({ capability, accessToken: ctx.credentials.accessToken, accepted })
    if (!accepted) throw new AuthExpiredError('401 Unauthorized')
    return innerContext(ctx)
  }

  const connector: FakeOAuthConnector = defineConnector({
    id: options.id ?? 'fake-oauth',
    name: 'Test OAuth channel',
    kind: 'marketplace',
    appConfigSchema: fakeOAuthAppSchema,
    configSchema: fakeOAuthConfigSchema,
    credentialsSchema: fakeOAuthCredentialsSchema,
    auth: {
      type: 'oauth2',
      expiresAt: (credentials) => credentials.accessTokenExpiresAt,
      async refresh(ctx, credentials) {
        clientIds.push(ctx.app.clientId)
        if (channel.options.refreshDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, channel.options.refreshDelayMs))
        const record = (outcome: 'rotated' | 'refused' | 'failed') => refreshes.push({ refreshToken: credentials.refreshToken, outcome })
        if (channel.options.refreshBehaviour === 'fail_transient') {
          record('failed')
          throw new TransientError('503 Service Unavailable')
        }
        const token = refreshTokens.get(credentials.refreshToken)
        if (channel.options.refreshBehaviour === 'fail_permanent' || !token?.valid) {
          record('refused')
          throw new AuthExpiredError('400 invalid_grant')
        }
        // Strict rotation: the old pair stops working at once (a real Channel may allow a short grace).
        token.valid = false
        const old = accessTokens.get(credentials.accessToken)
        if (old) old.valid = false
        record('rotated')
        return issue({ id: token.accountId, label: token.accountId })
      },
      deviceFlow: {
        verificationHosts: [FAKE_OAUTH_VERIFICATION_HOST],
        async start(ctx) {
          clientIds.push(ctx.app.clientId)
          const deviceCode = `fake-device-${crypto.randomUUID()}`
          const userCode = randomUserCode()
          devices.set(deviceCode, {
            userCode,
            status: channel.options.autoApprove ? 'approved' : 'pending',
            account: FAKE_OAUTH_DEFAULT_ACCOUNT,
            expiresAt: Date.now() + channel.options.deviceCodeLifetimeSeconds * 1000,
            slowDown: false,
            used: false,
          })
          return {
            deviceCode,
            userCode,
            verificationUri: `https://${FAKE_OAUTH_VERIFICATION_HOST}/activate`,
            verificationUriComplete: `https://${FAKE_OAUTH_VERIFICATION_HOST}/activate?code=${userCode}`,
            expiresInSeconds: channel.options.deviceCodeLifetimeSeconds,
            intervalSeconds: ctx.app.pollIntervalSeconds,
          }
        },
        async poll(ctx, deviceCode) {
          clientIds.push(ctx.app.clientId)
          const device = devices.get(deviceCode)
          // Like a real token endpoint: an unknown or already used code is a client error.
          if (!device || device.used) throw new PermanentError('400 Invalid device code')
          if (device.expiresAt <= Date.now()) return { status: 'expired' }
          if (device.slowDown) {
            device.slowDown = false
            return { status: 'slow_down' }
          }
          if (device.status !== 'approved') return { status: device.status }
          device.used = true
          return { status: 'approved', credentials: issue(device.account), account: channel.options.reportAccount ? device.account : null }
        },
      },
    },
    capabilities: {
      'offers.pull': async (ctx, cursor) => inner['offers.pull']!(authorise(ctx, 'offers.pull'), cursor),
      'orders.pull': async (ctx, cursor) => inner['orders.pull']!(authorise(ctx, 'orders.pull'), cursor),
      'stock.push': async (ctx, levels) => inner['stock.push']!(authorise(ctx, 'stock.push'), levels),
      'orders.updateStatus': async (ctx, input) => inner['orders.updateStatus']!(authorise(ctx, 'orders.updateStatus'), input),
    },
  })

  const channel: FakeOAuthChannel = {
    connector,
    data,
    options: defaults(),
    refreshes,
    tokenUses,
    clientIds,
    approve(userCode, account = FAKE_OAUTH_DEFAULT_ACCOUNT) {
      const device = findDevice(userCode)
      device.status = 'approved'
      device.account = account
    },
    deny(userCode) {
      findDevice(userCode).status = 'denied'
    },
    slowDown(userCode) {
      findDevice(userCode).slowDown = true
    },
    pendingUserCodes: () => [...devices.values()].filter((device) => device.status === 'pending').map((device) => device.userCode),
    issueCredentials: (account = FAKE_OAUTH_DEFAULT_ACCOUNT) => issue(account),
    expireAccessTokens() {
      for (const token of accessTokens.values()) token.valid = false
    },
    revokeAll() {
      for (const token of accessTokens.values()) token.valid = false
      for (const token of refreshTokens.values()) token.valid = false
    },
    accountOf: (accessToken) => accessTokens.get(accessToken)?.accountId,
    reset() {
      data.reset()
      accessTokens.clear()
      refreshTokens.clear()
      devices.clear()
      refreshes.length = 0
      tokenUses.length = 0
      clientIds.length = 0
      Object.assign(channel.options, defaults())
    },
  }
  return channel
}

/** Default instance, used by the connector registry (and the e2e probe, which approves its sign-ins). */
export const fakeOAuthChannel: FakeOAuthChannel = createFakeOAuthChannel()
export const fakeOAuthConnector = fakeOAuthChannel.connector
