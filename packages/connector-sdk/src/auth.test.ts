import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { deviceSignInPollSchema, isAllowedVerificationUri } from './auth'
import { defineConnector, deviceFlowOf } from './connector'

describe('isAllowedVerificationUri', () => {
  const hosts = ['allegro.pl', 'allegro.pl.allegrosandbox.pl']

  it.each([
    ['https://allegro.pl/skojarz-aplikacje', true],
    ['https://ALLEGRO.pl/skojarz-aplikacje?code=ABC', true],
    ['https://allegro.pl.allegrosandbox.pl/skojarz-aplikacje', true],
    ['http://allegro.pl/skojarz-aplikacje', false],
    ['https://evil.allegro.pl/skojarz-aplikacje', false],
    ['https://allegro.pl.evil.example/', false],
    ['https://user:pass@allegro.pl/', false],
    ['javascript:alert(1)', false],
    ['not a url', false],
    [null, false],
  ])('%s → %s', (uri, allowed) => {
    expect(isAllowedVerificationUri(uri, hosts)).toBe(allowed)
  })
})

describe('deviceSignInPollSchema', () => {
  it('accepts the waiting states and an approval with or without an account', () => {
    for (const status of ['pending', 'slow_down', 'denied', 'expired']) expect(deviceSignInPollSchema.safeParse({ status }).success).toBe(true)
    expect(deviceSignInPollSchema.safeParse({ status: 'approved', credentials: { a: 1 }, account: null }).success).toBe(true)
    expect(deviceSignInPollSchema.safeParse({ status: 'approved', credentials: {}, account: { id: 'x', label: 'y' } }).success).toBe(true)
  })

  it('rejects unknown states and an approval without an account field', () => {
    expect(deviceSignInPollSchema.safeParse({ status: 'later' }).success).toBe(false)
    expect(deviceSignInPollSchema.safeParse({ status: 'approved', credentials: {} }).success).toBe(false)
  })
})

describe('defineConnector with oauth2', () => {
  const page = async () => ({ items: [], nextCursor: null, hasMore: false })
  const definition = (verificationHosts: string[]) => ({
    id: 'example-oauth',
    name: 'Example',
    kind: 'marketplace' as const,
    appConfigSchema: z.object({ clientId: z.string() }),
    configSchema: z.object({}),
    credentialsSchema: z.object({ accessToken: z.string() }),
    auth: {
      type: 'oauth2' as const,
      deviceFlow: {
        start: async () => ({
          deviceCode: 'd',
          userCode: 'u',
          verificationUri: 'https://x.test',
          verificationUriComplete: null,
          expiresInSeconds: 60,
          intervalSeconds: 5,
        }),
        poll: async () => ({ status: 'pending' as const }),
        verificationHosts,
      },
    },
    capabilities: { 'offers.pull': page, 'orders.pull': page, 'stock.push': async () => {} },
  })

  it('rejects a device flow without verification hosts', () => {
    expect(() => defineConnector(definition([]))).toThrow(/verificationHosts/)
  })

  it('exposes the device flow', () => {
    const connector = defineConnector(definition(['x.test']))
    expect(deviceFlowOf(connector)?.verificationHosts).toEqual(['x.test'])
  })
})
