import { defineConnector } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DomainError } from '../errors'
import { createConnectorRegistry } from './registry'

const courier = (id: string) =>
  defineConnector({
    id,
    name: id,
    kind: 'courier',
    auth: { type: 'none' },
    configSchema: z.object({}),
    credentialsSchema: z.object({}),
    capabilities: {},
  })

describe('createConnectorRegistry', () => {
  it('lists and finds connectors by id', () => {
    const a = courier('a')
    const b = courier('b')
    const registry = createConnectorRegistry([a, b])
    expect(registry.list()).toEqual([a, b])
    expect(registry.get('b')).toBe(b)
    expect(registry.get('c')).toBeUndefined()
    expect(registry.require('a')).toBe(a)
  })

  it('throws on duplicate ids', () => {
    expect(() => createConnectorRegistry([courier('a'), courier('a')])).toThrow('Connector "a" is registered twice')
  })

  it('require throws unknown_connector', () => {
    const error = (() => {
      try {
        createConnectorRegistry([]).require('nope')
      } catch (caught) {
        return caught
      }
    })()
    expect(error).toBeInstanceOf(DomainError)
    expect(error).toMatchObject({ code: 'unknown_connector' })
  })
})
