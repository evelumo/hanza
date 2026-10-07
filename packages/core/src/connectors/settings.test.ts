import { defineConnector } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DomainError } from '../errors'
import { createConnectorRegistry } from './registry'
import { readConnectorSettings, settingsVariable } from './settings'

const withSettings = (id: string, appConfigSchema?: z.ZodObject) =>
  defineConnector({
    id,
    name: `Connector ${id}`,
    kind: 'courier',
    auth: { type: 'none' },
    ...(appConfigSchema ? { appConfigSchema } : {}),
    configSchema: z.object({}),
    credentialsSchema: z.object({}),
    capabilities: {},
  })

const allegroLike = withSettings(
  'my-shop',
  z.object({
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    environment: z.enum(['production', 'sandbox']).default('production'),
    pageSize: z.number().int().positive().default(100),
    verbose: z.boolean().default(false),
  }),
)

describe('settingsVariable', () => {
  it('upper-cases the id and turns camelCase fields into SCREAMING_SNAKE', () => {
    expect(settingsVariable('allegro', 'clientId')).toBe('HANZA_CONNECTOR_ALLEGRO_CLIENT_ID')
    expect(settingsVariable('fake-oauth', 'clientSecret')).toBe('HANZA_CONNECTOR_FAKE_OAUTH_CLIENT_SECRET')
    expect(settingsVariable('allegro', 'appName')).toBe('HANZA_CONNECTOR_ALLEGRO_APP_NAME')
    expect(settingsVariable('x', 'environment')).toBe('HANZA_CONNECTOR_X_ENVIRONMENT')
  })
})

describe('readConnectorSettings', () => {
  it('gives an empty object to a connector without installation settings', () => {
    expect(readConnectorSettings(withSettings('plain'), { HANZA_CONNECTOR_PLAIN_X: 'y' })).toEqual({ ok: true, value: {} })
  })

  it('reads only the connector’s own variables, converting numbers and booleans and applying defaults', () => {
    const result = readConnectorSettings(allegroLike, {
      HANZA_CONNECTOR_MY_SHOP_CLIENT_ID: ' client ',
      HANZA_CONNECTOR_MY_SHOP_CLIENT_SECRET: 'secret',
      HANZA_CONNECTOR_MY_SHOP_PAGE_SIZE: '50',
      HANZA_CONNECTOR_MY_SHOP_VERBOSE: 'true',
      HANZA_CONNECTOR_OTHER_CLIENT_ID: 'not mine',
    })
    expect(result).toEqual({
      ok: true,
      value: { clientId: 'client', clientSecret: 'secret', environment: 'production', pageSize: 50, verbose: true },
    })
  })

  it('names missing and invalid variables, never their values', () => {
    const result = readConnectorSettings(allegroLike, {
      HANZA_CONNECTOR_MY_SHOP_CLIENT_SECRET: 'super-secret',
      HANZA_CONNECTOR_MY_SHOP_ENVIRONMENT: 'staging',
      HANZA_CONNECTOR_MY_SHOP_CLIENT_ID: '',
    })
    expect(result).toEqual({ ok: false, variables: ['HANZA_CONNECTOR_MY_SHOP_CLIENT_ID', 'HANZA_CONNECTOR_MY_SHOP_ENVIRONMENT'] })
    expect(JSON.stringify(result)).not.toContain('super-secret')
    expect(JSON.stringify(result)).not.toContain('staging')
  })

  it('names every variable when a refinement on the whole object fails', () => {
    const refined = withSettings(
      'pair',
      z.object({ a: z.string().optional(), b: z.string().optional() }).refine((value) => value.a !== undefined || value.b !== undefined) as never,
    )
    expect(readConnectorSettings(refined, {})).toEqual({ ok: false, variables: ['HANZA_CONNECTOR_PAIR_A', 'HANZA_CONNECTOR_PAIR_B'] })
  })
})

describe('registry settings', () => {
  it('reads each connector’s settings once and refuses a connector that is not set up', () => {
    const registry = createConnectorRegistry([allegroLike, withSettings('plain')], { settings: {} })
    expect(registry.settings('plain')).toEqual({ ok: true, value: {} })
    expect(registry.requireConfigured('plain').id).toBe('plain')
    expect(registry.settings('my-shop')).toEqual({
      ok: false,
      variables: ['HANZA_CONNECTOR_MY_SHOP_CLIENT_ID', 'HANZA_CONNECTOR_MY_SHOP_CLIENT_SECRET'],
    })
    let error: unknown
    try {
      registry.requireConfigured('my-shop')
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(DomainError)
    expect(error).toMatchObject({
      code: 'connector_not_configured',
      message: 'Connector my-shop is not set up on this installation: HANZA_CONNECTOR_MY_SHOP_CLIENT_ID, HANZA_CONNECTOR_MY_SHOP_CLIENT_SECRET',
    })
    expect(() => registry.settings('unknown')).toThrow(DomainError)
  })
})
