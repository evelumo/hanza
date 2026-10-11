import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import {
  allegroAppConfigSchema,
  allegroConfigSchema,
  allegroCredentialsSchema,
  environmentHosts,
  OAUTH_SCOPES,
  userAgent,
  VERIFICATION_HOSTS,
} from './settings'

const app = { clientId: 'client-id-1234', clientSecret: 'client-secret-5678', appName: 'Hanza Test Shop' }

describe('allegroAppConfigSchema', () => {
  it('defaults the environment to production', () => {
    expect(allegroAppConfigSchema.parse(app).environment).toBe('production')
    expect(allegroAppConfigSchema.parse({ ...app, environment: 'sandbox' }).environment).toBe('sandbox')
  })

  it('refuses an unknown environment and an empty field', () => {
    expect(allegroAppConfigSchema.safeParse({ ...app, environment: 'staging' }).success).toBe(false)
    expect(allegroAppConfigSchema.safeParse({ ...app, clientId: '' }).success).toBe(false)
    expect(allegroAppConfigSchema.safeParse({ ...app, appName: '' }).success).toBe(false)
  })

  it('refuses values a header cannot carry', () => {
    expect(allegroAppConfigSchema.safeParse({ ...app, appName: 'Sklep Łódź' }).success).toBe(false)
    expect(allegroAppConfigSchema.safeParse({ ...app, appName: 'Shop\r\nX-Injected: 1' }).success).toBe(false)
    expect(allegroAppConfigSchema.safeParse({ ...app, appName: ' Shop' }).success).toBe(false)
    expect(allegroAppConfigSchema.safeParse({ ...app, clientSecret: 'with space' }).success).toBe(false)
  })

  it('is a flat object of labelled scalars and string enums, as the panel and the conformance kit need', () => {
    const json = z.toJSONSchema(allegroAppConfigSchema) as { properties: Record<string, { type?: string; enum?: unknown[]; description?: string }> }
    expect(Object.keys(json.properties)).toEqual(['clientId', 'clientSecret', 'environment', 'appName'])
    for (const property of Object.values(json.properties)) {
      expect(property.type).toBe('string')
      expect(property.description).toMatch(/\S/)
    }
    expect(json.properties.environment?.enum).toEqual(['production', 'sandbox'])
  })
})

describe('allegroConfigSchema and allegroCredentialsSchema', () => {
  it('has no Connection config', () => {
    expect(allegroConfigSchema.parse({})).toEqual({})
  })

  it('needs both tokens and an ISO expiry with an offset', () => {
    const credentials = { accessToken: 'a', refreshToken: 'r', accessTokenExpiresAt: '2026-10-10T12:00:00.000Z' }
    expect(allegroCredentialsSchema.parse(credentials)).toEqual(credentials)
    expect(allegroCredentialsSchema.safeParse({ ...credentials, accessTokenExpiresAt: '2026-10-10T12:00:00+02:00' }).success).toBe(true)
    expect(allegroCredentialsSchema.safeParse({ ...credentials, accessTokenExpiresAt: '2026-10-10 12:00' }).success).toBe(false)
    expect(allegroCredentialsSchema.safeParse({ ...credentials, refreshToken: '' }).success).toBe(false)
  })
})

describe('environmentHosts', () => {
  it('points production at allegro.pl', () => {
    expect(environmentHosts('production')).toEqual({
      api: 'https://api.allegro.pl',
      oauth: 'https://allegro.pl/auth/oauth',
      site: 'https://allegro.pl',
      verificationHost: 'allegro.pl',
    })
  })

  it('points the sandbox at allegrosandbox.pl', () => {
    expect(environmentHosts('sandbox')).toEqual({
      api: 'https://api.allegro.pl.allegrosandbox.pl',
      oauth: 'https://allegro.pl.allegrosandbox.pl/auth/oauth',
      site: 'https://allegro.pl.allegrosandbox.pl',
      verificationHost: 'allegro.pl.allegrosandbox.pl',
    })
  })

  it('allows the verification links of both environments', () => {
    expect(VERIFICATION_HOSTS).toEqual(['allegro.pl', 'allegro.pl.allegrosandbox.pl'])
  })
})

describe('OAUTH_SCOPES', () => {
  it('lists the five scopes Hanza needs', () => {
    expect([...OAUTH_SCOPES].sort()).toEqual([
      'allegro:api:orders:read',
      'allegro:api:orders:write',
      'allegro:api:profile:read',
      'allegro:api:sale:offers:read',
      'allegro:api:sale:offers:write',
    ])
  })
})

describe('userAgent', () => {
  it('is AppName/Version (+URL)', () => {
    expect(userAgent({ appName: 'Hanza Test Shop' })).toBe('Hanza Test Shop/0.1.0 (+https://github.com/evelumo/hanza)')
  })
})
