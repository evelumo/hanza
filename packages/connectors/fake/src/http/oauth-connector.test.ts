import { readdir, readFile } from 'node:fs/promises'
import {
  CONFORMANCE_CASSETTE,
  DEVICE_FLOW_CASSETTE,
  REFRESH_CASSETTE,
  REFRESH_REFUSED_CASSETTE,
  runConformance,
  UNAUTHORIZED_CASSETTE,
} from '@hanza/connector-sdk/testing'
import { describe, expect, it } from 'vitest'
import { createFakeHttpOAuthConnector } from './oauth-connector'
import { fakeHttpScrub, startFakeHttpServer } from './server'

const connector = createFakeHttpOAuthConnector()
const fixtures = new URL('./fixtures-oauth/', import.meta.url)

// What the replay sends in place of the recorded secrets; scrubbed before matching, like the recorded ones were.
const app = { clientId: 'replay-client-id', clientSecret: 'replay-client-secret' }
const credentials = { accessToken: 'replay-access-token', refreshToken: 'replay-refresh-token', accessTokenExpiresAt: '2030-01-01T00:00:00.000Z' }

// Recording only (HANZA_RECORD_FIXTURES=1): a real connector loads these from its git-ignored .recording/ instead.
const recordedApp = { clientId: 'recorded-client-id', clientSecret: 'recorded-client-secret' }

describe('fake-http-oauth connector with recorded fixtures', () => {
  it('passes the conformance kit (C2 with installation settings, C15 refresh, C16 device flow) against its cassettes', async () => {
    await runConformance(connector, {
      fixtures,
      app,
      config: {},
      credentials,
      unauthorized: { credentials: { ...credentials, accessToken: 'replay-revoked-access-token' } },
      refresh: { refused: { credentials: { ...credentials, refreshToken: 'replay-refused-refresh-token' } } },
      deviceFlow: true,
      scrub: fakeHttpScrub,
      recording: async () => {
        const server = await startFakeHttpServer({ ...recordedApp, autoApproveDevices: true })
        const pair = server.signIn()
        const recorded = {
          accessToken: pair.accessToken,
          refreshToken: pair.refreshToken,
          accessTokenExpiresAt: new Date(Date.now() + pair.expiresIn * 1000).toISOString(),
        }
        return {
          app: recordedApp,
          credentials: recorded,
          unauthorizedCredentials: { ...recorded, accessToken: 'recorded-revoked-access-token' },
          refusedRefreshCredentials: { ...recorded, refreshToken: 'recorded-refused-refresh-token' },
          fetch: server.fetch,
          close: server.close,
        }
      },
    })
  })

  it('keeps the application credentials and every token out of the committed cassettes', async () => {
    const names = (await readdir(fixtures)).sort()
    expect(names).toEqual([CONFORMANCE_CASSETTE, DEVICE_FLOW_CASSETTE, REFRESH_CASSETTE, REFRESH_REFUSED_CASSETTE, UNAUTHORIZED_CASSETTE].sort())
    for (const name of names) {
      const text = await readFile(new URL(name, fixtures), 'utf8')
      for (const secret of [...Object.values(recordedApp), 'recorded-revoked-access-token', 'recorded-refused-refresh-token']) {
        expect(text, name).not.toContain(secret)
      }
      expect(text, name).not.toMatch(/eyJ[A-Za-z0-9_-]{4,}\./)
      expect(text.toLowerCase(), name).not.toContain('basic ')
    }
  })

  it('signs in through the device flow and rotates the refresh token on a live server', async () => {
    const server = await startFakeHttpServer(recordedApp)
    try {
      const ctx = { app: recordedApp, config: { baseUrl: 'https://fake-channel.example.test' }, fetch: server.fetch, log: () => {} }
      const flow = connector.auth.type === 'oauth2' ? connector.auth.deviceFlow! : (undefined as never)
      const started = await flow.start(ctx)
      expect(await flow.poll(ctx, started.deviceCode)).toEqual({ status: 'pending' })
      server.approve(started.userCode)
      const approved = await flow.poll(ctx, started.deviceCode)
      expect(approved).toMatchObject({ status: 'approved', account: { id: 'fake-seller-1', label: 'fake-seller' } })
      const signedIn = (approved as { credentials: typeof credentials }).credentials
      const refresh = connector.auth.type === 'oauth2' ? connector.auth.refresh! : (undefined as never)
      const rotated = await refresh(ctx, signedIn)
      expect(rotated.refreshToken).not.toBe(signedIn.refreshToken)
      await expect(refresh(ctx, signedIn)).rejects.toMatchObject({ kind: 'auth_expired' })
      await expect(flow.poll(ctx, started.deviceCode)).rejects.toMatchObject({ kind: 'permanent' })
    } finally {
      await server.close()
    }
  })
})
