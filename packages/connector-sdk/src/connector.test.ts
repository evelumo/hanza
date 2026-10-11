import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { canShip, defineConnector, findShippingService, isChannel, listCapabilities, shippingProblem, type AnyConnectorDefinition } from './connector'
import type { ShippingService } from './model/shipment'

const base = {
  name: 'Example',
  auth: { type: 'apiKey' as const },
  configSchema: z.object({ baseUrl: z.url() }),
  credentialsSchema: z.object({ token: z.string() }),
}

const page = async () => ({ items: [], nextCursor: null, hasMore: false })
const channelCapabilities = { 'offers.pull': page, 'orders.pull': page, 'stock.push': async () => {} }

describe('defineConnector', () => {
  it('lists only the capabilities a connector implements', () => {
    const connector = defineConnector({
      ...base,
      id: 'example-courier',
      kind: 'courier',
      capabilities: { 'orders.updateStatus': async () => {} },
    })
    expect(listCapabilities(connector)).toEqual(['orders.updateStatus'])
  })

  it('rejects ids that are not lowercase slugs', () => {
    expect(() => defineConnector({ ...base, id: 'Example Shop', kind: 'courier', capabilities: {} })).toThrow(
      /Invalid connector id/,
    )
  })

  it.each(['offers.pull', 'orders.pull', 'stock.push'] as const)('rejects a Channel without %s', (missing) => {
    const { [missing]: _removed, ...capabilities } = channelCapabilities
    expect(() => defineConnector({ ...base, id: 'example-shop', kind: 'shop', capabilities })).toThrow(
      new RegExp(`must implement ${missing}`),
    )
    expect(() => defineConnector({ ...base, id: 'example-market', kind: 'marketplace', capabilities })).toThrow(
      new RegExp(missing),
    )
  })

  it('accepts a Channel with the required capabilities and a courier with none', () => {
    expect(() => defineConnector({ ...base, id: 'example-shop', kind: 'shop', capabilities: channelCapabilities })).not.toThrow()
    expect(() => defineConnector({ ...base, id: 'example-courier', kind: 'courier', capabilities: {} })).not.toThrow()
  })

  it('accepts positive integer rate limits and rejects anything else', () => {
    const define = (rateLimits: unknown) => () =>
      defineConnector({ ...base, id: 'example-courier', kind: 'courier', capabilities: {}, rateLimits: rateLimits as never })
    expect(define({ application: { requests: 6000, windowMs: 60_000 }, connection: { concurrency: 3 } })).not.toThrow()
    expect(define({ connection: { rate: { requests: 5, windowMs: 1000 } } })).not.toThrow()
    expect(define({ application: { requests: 0, windowMs: 1000 } })).toThrow(/rateLimits.application/)
    expect(define({ connection: { rate: { requests: 5, windowMs: 0.5 } } })).toThrow(/rateLimits.connection.rate/)
    expect(define({ connection: { concurrency: -1 } })).toThrow(/concurrency/)
  })

  it('keeps definitions with specific config types assignable to AnyConnectorDefinition', () => {
    const connector: AnyConnectorDefinition = defineConnector({
      ...base,
      id: 'example-shop',
      kind: 'shop',
      capabilities: { ...channelCapabilities, 'stock.push': async (ctx) => void ctx.config.baseUrl.length },
    })
    expect(connector.id).toBe('example-shop')
  })
})

describe('defineConnector with shipments', () => {
  const locker: ShippingService = {
    id: 'locker',
    name: 'Locker',
    destination: 'pickup_point',
    parcel: { type: 'presets', presets: [{ id: 'small', name: 'Small' }, { id: 'large', name: 'Large' }] },
    cashOnDelivery: true,
  }
  const door: ShippingService = { id: 'door', name: 'To the door', destination: 'address', parcel: { type: 'dimensions' }, cashOnDelivery: false }
  const shipments = {
    'shipments.create': async () => ({ outcome: 'rejected' as const, code: 'no' }),
    'shipments.track': async () => [],
    'shipments.label': async () => ({ contentType: 'application/pdf', data: new Uint8Array([1]) }),
  }
  const define = (capabilities: AnyConnectorDefinition['capabilities'], services?: unknown, kind: 'courier' | 'shop' = 'courier') => () =>
    defineConnector({
      ...base,
      id: 'example-carrier',
      kind,
      capabilities,
      ...(services === undefined ? {} : { shipping: { services: services as ShippingService[] } }),
    })

  it('accepts a courier with create, track, label and services, with or without cancel', () => {
    expect(define(shipments, [locker, door])).not.toThrow()
    expect(define({ ...shipments, 'shipments.cancel': async () => ({ outcome: 'cancelled' as const }) }, [door])).not.toThrow()
  })

  it('accepts a Channel that makes Shipments too: the rule is about capabilities, not the kind', () => {
    const connector = define({ ...channelCapabilities, ...shipments }, [locker], 'shop')()
    expect(canShip(connector)).toBe(true)
    expect(isChannel(connector)).toBe(true)
  })

  it.each(['shipments.track', 'shipments.label'] as const)('rejects shipments.create without %s', (missing) => {
    const { [missing]: _removed, ...capabilities } = shipments
    expect(define(capabilities, [locker])).toThrow(new RegExp(`Connector "example-carrier": shipments\\.create needs ${missing.replace('.', '\\.')} as well`))
  })

  it('rejects shipments.create without a service', () => {
    expect(define(shipments)).toThrow(/Connector "example-carrier": shipments\.create needs at least one service/)
    expect(define(shipments, [])).toThrow(/at least one service/)
  })

  it('rejects services without shipments.create', () => {
    expect(define({}, [locker])).toThrow(/Connector "example-carrier": shipping\.services are declared but shipments\.create is missing/)
    expect(define({ 'shipments.track': shipments['shipments.track'], 'shipments.label': shipments['shipments.label'] }, [locker])).toThrow(/shipments\.create is missing/)
    expect(define({}, [])).not.toThrow()
  })

  it('rejects empty and repeated service ids', () => {
    expect(define(shipments, [locker, { ...door, id: '' }])).toThrow(/Connector "example-carrier": shipping service #2 has an empty id/)
    expect(define(shipments, [locker, { ...door, id: 'locker' }])).toThrow(/shipping service "locker" is declared twice/)
  })

  it('rejects a presets service without presets or with a repeated preset id', () => {
    expect(define(shipments, [{ ...locker, parcel: { type: 'presets', presets: [] } }])).toThrow(/shipping service "locker" has no parcel presets/)
    const twice = { type: 'presets', presets: [{ id: 'small', name: 'Small' }, { id: 'small', name: 'S' }] }
    expect(define(shipments, [{ ...locker, parcel: twice }])).toThrow(/shipping service "locker" declares the parcel preset "small" twice/)
  })

  it('rejects a service that is not well formed, naming the field', () => {
    expect(define(shipments, [{ ...door, destination: 'door' }])).toThrow(/shipping service "door" is not well formed \(destination: /)
    expect(define(shipments, [{ ...door, name: '' }])).toThrow(/shipping service "door" is not well formed \(name: /)
    expect(define(shipments, [{ ...locker, parcel: { type: 'presets', presets: [{ id: '', name: 'Small' }] } }])).toThrow(/not well formed \(parcel\.presets\.0\.id: /)
  })

  it('tells whether a connector ships, and finds a service by id', () => {
    const carrier = define(shipments, [locker, door])()
    expect(canShip(carrier)).toBe(true)
    expect(findShippingService(carrier, 'door')).toEqual(door)
    expect(findShippingService(carrier, 'drone')).toBeUndefined()
    expect(listCapabilities(carrier)).toEqual(['shipments.create', 'shipments.track', 'shipments.label'])

    const channel = defineConnector({ ...base, id: 'example-shop', kind: 'shop', capabilities: channelCapabilities })
    expect(canShip(channel)).toBe(false)
    expect(findShippingService(channel, 'door')).toBeUndefined()
    expect(shippingProblem(channel)).toBeNull()
  })
})

describe('isChannel', () => {
  it.each([
    ['marketplace', true],
    ['shop', true],
    ['courier', false],
    ['invoicing', false],
  ] as const)('%s -> %s', (kind, expected) => {
    expect(isChannel({ ...base, id: 'x', kind, capabilities: {} })).toBe(expected)
  })
})
