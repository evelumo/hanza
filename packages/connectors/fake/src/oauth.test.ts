import { classifyConnectorError, type AuthContext } from '@hanza/connector-sdk'
import { assertConformance } from '@hanza/connector-sdk/testing'
import { describe, expect, it } from 'vitest'
import { createFakeOAuthChannel, FAKE_OAUTH_DEFAULT_ACCOUNT, type FakeOAuthCredentials } from './oauth'

const app = { clientId: 'client', clientSecret: 'secret', pollIntervalSeconds: 1 }

const authContext = (): AuthContext<Record<string, never>, typeof app> => ({
  app,
  config: {},
  fetch: async () => {
    throw new Error('the fake connector never uses the network')
  },
  log: () => {},
})

const kindOf = (promise: Promise<unknown>) => promise.then(() => 'resolved', (error: unknown) => classifyConnectorError(error).kind)

describe('fake OAuth connector', () => {
  it('passes the conformance kit, refresh and device flow included', async () => {
    const channel = createFakeOAuthChannel()
    const credentials = channel.issueCredentials()
    // C15 polls once, right after start.
    channel.options.autoApprove = true
    const refused = channel.issueCredentials()
    channel.revokeAll()
    const fresh = channel.issueCredentials()
    await assertConformance(channel.connector, {
      app,
      config: {},
      credentials: fresh,
      unauthorized: { credentials: credentials },
      refresh: { refused: { credentials: refused } },
      deviceFlow: {},
    })
  })

  it('serves capabilities only with a valid access token and records which token each call used', async () => {
    const channel = createFakeOAuthChannel()
    const credentials = channel.issueCredentials()
    const pull = channel.connector.capabilities['offers.pull']!
    const ctx = { ...authContext(), credentials }
    await expect(pull(ctx, null)).resolves.toMatchObject({ hasMore: true })
    channel.expireAccessTokens()
    expect(await kindOf(pull(ctx, null))).toBe('auth_expired')
    expect(channel.tokenUses.map((use) => [use.capability, use.accepted])).toEqual([
      ['offers.pull', true],
      ['offers.pull', false],
    ])
    expect(channel.clientIds.every((id) => id === 'client')).toBe(true)
  })

  it('rotates the pair on refresh and refuses the old one afterwards', async () => {
    const channel = createFakeOAuthChannel()
    const refresh = channel.connector.auth.type === 'oauth2' ? channel.connector.auth.refresh! : () => Promise.reject()
    const first = channel.issueCredentials()
    const second = (await refresh(authContext(), first)) as FakeOAuthCredentials
    expect(second.accessToken).not.toBe(first.accessToken)
    expect(second.refreshToken).not.toBe(first.refreshToken)
    expect(await kindOf(refresh(authContext(), first))).toBe('auth_expired')
    expect(await kindOf(channel.connector.capabilities['stock.push']!({ ...authContext(), credentials: first }, []))).toBe('auth_expired')
    expect(channel.refreshes.map((entry) => entry.outcome)).toEqual(['rotated', 'refused'])
  })

  it('fails a refresh permanently or transiently on demand', async () => {
    const channel = createFakeOAuthChannel()
    const refresh = channel.connector.auth.type === 'oauth2' ? channel.connector.auth.refresh! : () => Promise.reject()
    channel.options.refreshBehaviour = 'fail_transient'
    expect(await kindOf(refresh(authContext(), channel.issueCredentials()))).toBe('transient')
    channel.options.refreshBehaviour = 'fail_permanent'
    expect(await kindOf(refresh(authContext(), channel.issueCredentials()))).toBe('auth_expired')
  })

  it('runs the device flow: pending, slow down, approval once, then the code is spent', async () => {
    const channel = createFakeOAuthChannel()
    const flow = channel.connector.auth.type === 'oauth2' ? channel.connector.auth.deviceFlow! : (undefined as never)
    const started = await flow.start(authContext())
    expect(started).toMatchObject({ intervalSeconds: 1, verificationUri: 'https://fake-oauth.hanza.test/activate' })
    expect(channel.pendingUserCodes()).toEqual([started.userCode])
    expect(await flow.poll(authContext(), started.deviceCode)).toEqual({ status: 'pending' })
    channel.slowDown(started.userCode)
    expect(await flow.poll(authContext(), started.deviceCode)).toEqual({ status: 'slow_down' })
    const grouped = started.userCode.replace(/(...)(...)(...)/, '$1 $2 $3')
    channel.approve(grouped, { id: 'seller-2', label: 'other' })
    const approved = await flow.poll(authContext(), started.deviceCode)
    expect(approved).toMatchObject({ status: 'approved', account: { id: 'seller-2', label: 'other' } })
    expect(channel.accountOf((approved as { credentials: FakeOAuthCredentials }).credentials.accessToken)).toBe('seller-2')
    expect(await kindOf(flow.poll(authContext(), started.deviceCode))).toBe('permanent')
  })

  it('reports a denied sign-in', async () => {
    const channel = createFakeOAuthChannel()
    const flow = channel.connector.auth.type === 'oauth2' ? channel.connector.auth.deviceFlow! : (undefined as never)
    const started = await flow.start(authContext())
    channel.deny(started.userCode)
    expect(await flow.poll(authContext(), started.deviceCode)).toEqual({ status: 'denied' })
    expect(FAKE_OAUTH_DEFAULT_ACCOUNT.id).toBe('fake-seller-1')
  })
})
