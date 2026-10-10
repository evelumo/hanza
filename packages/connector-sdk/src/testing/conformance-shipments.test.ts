import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AnyConnectorDefinition, CapabilityContext } from '../connector'
import { AuthExpiredError, PermanentError, TransientError, errorFromResponse } from '../errors'
import type { Order } from '../model/order'
import type { ShipmentRequest, ShipmentState, ShipmentStatus, ShippingService } from '../model/shipment'
import { assertConformance, type ConformanceFixtures } from './index'

const locker: ShippingService = {
  id: 'locker',
  name: 'Locker',
  destination: 'pickup_point',
  parcel: { type: 'presets', presets: [{ id: 'small', name: 'Small' }, { id: 'large', name: 'Large' }] },
  cashOnDelivery: true,
}
const door: ShippingService = { id: 'door', name: 'To the door', destination: 'address', parcel: { type: 'dimensions' }, cashOnDelivery: false }

const request: ShipmentRequest = {
  reference: 'shp_1',
  requestedAt: '2026-10-10T09:00:00Z',
  service: 'locker',
  receiver: { name: 'John Test', company: null, email: 'john@example.com', phone: '600100200' },
  destination: { type: 'pickup_point', pointId: 'KRA010' },
  parcel: { preset: 'small' },
  cashOnDelivery: null,
}
const refused: ShipmentRequest = { ...request, reference: 'shp_2', destination: { type: 'pickup_point', pointId: 'NOWHERE' } }

const fixtures: ConformanceFixtures = {
  config: {},
  credentials: { apiKey: 'test' },
  unauthorized: { credentials: { apiKey: 'expired' } },
  shipment: { request, rejected: { request: refused } },
}

type Capabilities = AnyConnectorDefinition['capabilities']
interface Calls {
  create: ShipmentRequest[]
  track: string[][]
  label: string[]
  cancel: string[]
}

/**
 * An in-memory Carrier that satisfies S1 to S7. A Shipment is confirmed the first time it is tracked, and has a
 * Label from then on, like a Carrier that buys the postage a moment after the request.
 */
function courier(overrides: Partial<AnyConnectorDefinition> = {}, calls: Calls = { create: [], track: [], label: [], cancel: [] }): AnyConnectorDefinition {
  const byReference = new Map<string, ShipmentState>()
  const find = (externalId: string) => [...byReference.values()].find((shipment) => shipment.externalId === externalId)
  const authorise = (ctx: CapabilityContext) => {
    if ((ctx.credentials as { apiKey: string }).apiKey === 'expired') throw new AuthExpiredError('expired')
  }
  const capabilities: Capabilities = {
    'shipments.create': async (ctx, shipmentRequest) => {
      authorise(ctx)
      calls.create.push(shipmentRequest)
      const { destination, reference } = shipmentRequest
      if (destination.type === 'pickup_point' && destination.pointId === 'NOWHERE') return { outcome: 'rejected', code: 'target_point.does_not_exist' }
      const known = byReference.get(reference)
      if (known) return { outcome: 'created', ...known }
      const state: ShipmentState = { externalId: `ext-${byReference.size + 1}`, status: 'pending', trackingNumber: null, carrierStatus: 'created' }
      byReference.set(reference, state)
      return { outcome: 'created', ...state }
    },
    'shipments.track': async (ctx, externalIds) => {
      authorise(ctx)
      calls.track.push(externalIds)
      return externalIds.flatMap((externalId) => {
        const shipment = find(externalId)
        if (!shipment) return []
        if (shipment.status === 'pending') Object.assign(shipment, { status: 'ready', trackingNumber: `TRACK-${externalId}`, carrierStatus: 'confirmed' })
        return [{ ...shipment }]
      })
    },
    'shipments.label': async (ctx, { externalId }) => {
      authorise(ctx)
      calls.label.push(externalId)
      if (find(externalId)?.status === 'pending') throw new TransientError('no label yet')
      return { contentType: 'application/pdf', data: new TextEncoder().encode('%PDF-1.4') }
    },
    'shipments.cancel': async (ctx, { externalId }) => {
      authorise(ctx)
      calls.cancel.push(externalId)
      const shipment = find(externalId)
      if (shipment) shipment.status = 'cancelled'
      return { outcome: 'cancelled' }
    },
  }
  return {
    id: 'carrier',
    name: 'Carrier',
    kind: 'courier',
    auth: { type: 'apiKey' },
    configSchema: z.object({}),
    credentialsSchema: z.object({ apiKey: z.string().min(1) }),
    capabilities,
    shipping: { services: [locker, door] },
    ...overrides,
  }
}

/** The courier with some capabilities replaced; `inner` is the working one, to wrap. */
function withCapabilities(replace: (inner: Capabilities) => Capabilities): AnyConnectorDefinition {
  const inner = courier()
  return { ...inner, capabilities: { ...inner.capabilities, ...replace(inner.capabilities) } }
}

const state = (status: ShipmentStatus = 'pending', externalId = 'ext-1'): ShipmentState => ({ externalId, status, trackingNumber: null, carrierStatus: null })
const servingFetch = (async () => new Response('{}')) as typeof fetch

// Tracks over ctx.fetch, so the 403 of C14 and the request count of S4 reach it.
function httpCourier(options: Parameters<typeof errorFromResponse>[1] = {}, alsoWhenEmpty = false) {
  return withCapabilities((inner) => ({
    'shipments.track': async (ctx, externalIds) => {
      if (externalIds.length > 0 || alsoWhenEmpty) {
        const response = await ctx.fetch('https://carrier.example.test/shipments')
        if (!response.ok) throw await errorFromResponse(response, options)
      }
      return inner['shipments.track']!(ctx, externalIds)
    },
  }))
}
const httpFixtures: ConformanceFixtures = { ...fixtures, unauthorized: undefined, fetch: servingFetch }

const broken: Array<[ids: string[], what: string, connector: AnyConnectorDefinition, fixtures?: ConformanceFixtures]> = [
  [['S1'], 'a service id declared twice', courier({ shipping: { services: [locker, { ...door, id: 'locker' }] } })],
  [['S1'], 'a service with an empty id', courier({ shipping: { services: [locker, { ...door, id: '' }] } })],
  [['S1'], 'a presets service without presets', courier({ shipping: { services: [{ ...locker, parcel: { type: 'presets', presets: [] } }] } })],
  [['S1'], 'a service with an unknown destination', courier({ shipping: { services: [{ ...locker, destination: 'locker' as never }] } })],
  [['S1'], 'no services', courier({ shipping: undefined })],
  [['S1'], 'no shipments.label', withCapabilities(() => ({ 'shipments.label': undefined }))],
  [['S1'], 'services without shipments.create', courier({ capabilities: {} }), { ...fixtures, unauthorized: undefined }],

  [['S2'], 'no shipment fixture', courier(), { ...fixtures, shipment: undefined }],
  [['S2'], 'a fixture for a service that is not declared', courier(), { ...fixtures, shipment: { request: { ...request, service: 'drone' } } }],
  [['S2'], 'a fixture that does not fit its service', courier(), { ...fixtures, shipment: { request: { ...request, service: 'door' } } }],
  [['S2'], 'a fixture that is not a request', courier(), { ...fixtures, shipment: { request: { ...request, requestedAt: 'today' } } }],
  [['S2'], 'a result without an id', withCapabilities(() => ({ 'shipments.create': async () => ({ outcome: 'created', ...state(), externalId: '' }) })), { ...fixtures, shipment: { request } }],
  [['S2'], 'a Carrier status that is free text', withCapabilities(() => ({ 'shipments.create': async () => ({ outcome: 'created', ...state(), carrierStatus: 'Przyjęta w oddziale' }) })), { ...fixtures, shipment: { request } }],
  [['S2'], 'a new Shipment that is already delivered', withCapabilities((inner) => ({
    'shipments.create': async (ctx, shipmentRequest) => {
      const result = await inner['shipments.create']!(ctx, shipmentRequest)
      return result.outcome === 'created' ? { ...result, status: 'delivered' as const } : result
    },
  }))],
  [['S2'], 'the fixture rejected', withCapabilities(() => ({ 'shipments.create': async () => ({ outcome: 'rejected', code: 'no_funds' }) })), { ...fixtures, shipment: { request } }],
  [['S2'], 'create that fails', withCapabilities(() => ({ 'shipments.create': async () => { throw new PermanentError('down') } })), { ...fixtures, shipment: { request } }],

  [['S3'], 'another Shipment for the same reference', (() => {
    let made = 0
    return withCapabilities((inner) => ({
      'shipments.create': async (ctx, shipmentRequest) => {
        const result = await inner['shipments.create']!(ctx, { ...shipmentRequest, reference: `${shipmentRequest.reference}#${made++}` })
        return result
      },
      // Every one of them exists at this Carrier, which is the bug.
      'shipments.track': async (_ctx, externalIds) => externalIds.map((externalId) => state('ready', externalId)),
      'shipments.label': async () => ({ contentType: 'application/pdf', data: new Uint8Array([1]) }),
    }))
  })(), { ...fixtures, unauthorized: undefined }],
  [['S3'], 'a repeat that is rejected', (() => {
    const seen = new Set<string>()
    return withCapabilities((inner) => ({
      'shipments.create': async (ctx, shipmentRequest) => {
        if (seen.has(shipmentRequest.reference)) return { outcome: 'rejected', code: 'duplicate_reference' }
        seen.add(shipmentRequest.reference)
        return inner['shipments.create']!(ctx, shipmentRequest)
      },
    }))
  })(), { ...fixtures, shipment: { request } }],

  [['S4'], 'a state for a Shipment that was not asked for', withCapabilities((inner) => ({
    'shipments.track': async (ctx, externalIds) => [...(await inner['shipments.track']!(ctx, externalIds)), ...(externalIds.length > 0 ? [state('ready', 'someone-elses')] : [])],
  }))],
  [['S4'], 'no state for the Shipment just made', withCapabilities((inner) => ({
    'shipments.track': async (ctx, externalIds) => {
      await inner['shipments.track']!(ctx, externalIds)
      return []
    },
  }))],
  [['S4'], 'two states for one Shipment', withCapabilities((inner) => ({
    'shipments.track': async (ctx, externalIds) => {
      const states = await inner['shipments.track']!(ctx, externalIds)
      return [...states, ...states]
    },
  }))],
  [['S4'], 'a state with an unknown status', withCapabilities((inner) => ({
    'shipments.track': async (ctx, externalIds) => (await inner['shipments.track']!(ctx, externalIds)).map((tracked) => ({ ...tracked, status: 'confirmed' as never })),
  }))],
  [['S4'], 'something that is not a list', withCapabilities((inner) => ({
    'shipments.track': async (ctx, externalIds) => {
      const states = await inner['shipments.track']!(ctx, externalIds)
      return (externalIds.length > 0 ? { items: states } : states) as never
    },
  }))],
  [['S4'], 'a request to the Carrier with nothing to track', httpCourier({}, true), httpFixtures],
  [['S4'], 'a failure with nothing to track', withCapabilities((inner) => ({
    'shipments.track': async (ctx, externalIds) => {
      if (externalIds.length === 0) throw new PermanentError('ids are required')
      return inner['shipments.track']!(ctx, externalIds)
    },
  }))],

  [['S5'], 'an empty file', withCapabilities(() => ({ 'shipments.label': async () => ({ contentType: 'application/pdf', data: new Uint8Array() }) }))],
  [['S5'], 'no content type', withCapabilities(() => ({ 'shipments.label': async () => ({ contentType: '', data: new Uint8Array([1]) }) }))],
  [['S5'], 'a file that is not bytes', withCapabilities(() => ({ 'shipments.label': async () => ({ contentType: 'application/pdf', data: 'JVBERg==' as never }) }))],
  [['S5'], 'a Label that never comes', withCapabilities(() => ({ 'shipments.label': async () => { throw new TransientError('no label yet') } }))],
  [['S5'], 'a permanent failure', withCapabilities(() => ({ 'shipments.label': async () => { throw new PermanentError('labels are off') } }))],

  [['S6'], 'a Shipment made for the rejected fixture', courier(), { ...fixtures, shipment: { request, rejected: { request: { ...refused, destination: request.destination } } } }],
  [['S6'], 'an error instead of the outcome', withCapabilities((inner) => ({
    'shipments.create': async (ctx, shipmentRequest) => {
      if (shipmentRequest.reference === refused.reference) throw new PermanentError('unknown pickup point')
      return inner['shipments.create']!(ctx, shipmentRequest)
    },
  }))],
  [['S6'], 'a code that is free text', withCapabilities((inner) => ({
    'shipments.create': async (ctx, shipmentRequest) => {
      const result = await inner['shipments.create']!(ctx, shipmentRequest)
      return result.outcome === 'rejected' ? { ...result, code: 'The pickup point does not exist' } : result
    },
  }))],
  [['S6'], 'a rejected fixture with the same reference', courier(), { ...fixtures, shipment: { request, rejected: { request: { ...refused, reference: request.reference } } } }],
  [['S6'], 'a rejected fixture that does not fit its service', courier(), { ...fixtures, shipment: { request, rejected: { request: { ...refused, parcel: { preset: 'huge' } } } } }],

  [['S7'], 'an outcome that is not one of the two', withCapabilities(() => ({ 'shipments.cancel': async () => ({ outcome: 'ok' }) as never }))],
  [['S7'], 'refused without a code', withCapabilities(() => ({ 'shipments.cancel': async () => ({ outcome: 'refused' }) as never }))],
  [['S7'], 'cancelled, then refused', (() => {
    let cancels = 0
    return withCapabilities(() => ({ 'shipments.cancel': async () => (cancels++ === 0 ? { outcome: 'cancelled' } : { outcome: 'refused', code: 'not_found' }) }))
  })()],
  [['S7'], 'a second cancel that fails', (() => {
    let cancels = 0
    return withCapabilities(() => ({
      'shipments.cancel': async () => {
        if (cancels++ > 0) throw new PermanentError('already cancelled')
        return { outcome: 'cancelled' }
      },
    }))
  })()],

  [['S2', 'C12'], 'create rejecting with a plain error', withCapabilities(() => ({ 'shipments.create': async () => { throw new Error('plain error') } })), { ...fixtures, shipment: { request } }],
  [['S4', 'C12'], 'track rejecting with a plain error', withCapabilities((inner) => ({
    'shipments.track': async (ctx, externalIds) => {
      if (externalIds.length === 0) throw new Error('plain error')
      return inner['shipments.track']!(ctx, externalIds)
    },
  }))],
  [['S5', 'C12'], 'label rejecting with a plain error', withCapabilities(() => ({ 'shipments.label': async () => { throw new Error('plain error') } }))],
  [['S7', 'C12'], 'cancel rejecting with a plain error', withCapabilities(() => ({ 'shipments.cancel': async () => { throw new TypeError('fetch failed') } }))],

  [['C11'], 'track that accepts bad credentials', courier(), { ...fixtures, unauthorized: { credentials: { apiKey: 'also-fine' } } }],
  [['C11'], 'track that fails as permanent on bad credentials', withCapabilities((inner) => ({
    'shipments.track': async (ctx, externalIds) => {
      if ((ctx.credentials as { apiKey: string }).apiKey === 'expired') throw new PermanentError('401')
      return inner['shipments.track']!(ctx, externalIds)
    },
  }))],
  [['C11'], 'track without create, so no Shipment to track', courier({ capabilities: { 'shipments.track': async () => [] }, shipping: undefined })],
  [['C14'], 'track that asks for sign-in on a bare 403', httpCourier({ isAuthFailure: (response) => response.status === 403 }), httpFixtures],
  // Given recorded responses, but its track never calls fetch: C14 would pass without seeing a 403.
  [['C14'], 'track that never met the 403', courier(), httpFixtures],
]

const failedChecks = (error: Error) => [...new Set([...error.message.matchAll(/^\[(\w+)\]/gm)].map((match) => match[1]!))]

describe('assertConformance for a connector that makes Shipments', () => {
  it('passes for an in-memory courier, with and without cancel and the rejected fixture', async () => {
    await expect(assertConformance(courier(), fixtures)).resolves.toBeUndefined()
    const withoutCancel = withCapabilities(() => ({ 'shipments.cancel': undefined }))
    await expect(assertConformance(withoutCancel, { ...fixtures, shipment: { request } })).resolves.toBeUndefined()
  })

  it('creates one Shipment twice, tracks it, takes its Label once it is there and cancels it twice, in that order', async () => {
    const calls: Calls = { create: [], track: [], label: [], cancel: [] }
    await assertConformance(courier({}, calls), { ...fixtures, unauthorized: undefined })
    expect(calls.create).toEqual([request, request, refused])
    // The repeat is another object: a connector must know it by its reference.
    expect(calls.create[1]).not.toBe(calls.create[0])
    // S4 with the Shipment and with nothing, then C14 with the Shipment again.
    expect(calls.track).toEqual([['ext-1'], [], ['ext-1']])
    expect(calls.label).toEqual(['ext-1'])
    expect(calls.cancel).toEqual(['ext-1', 'ext-1'])
  })

  it('asks for the Label again while it fails as transient, tracking in between, up to labelAttempts', async () => {
    // Confirmed only on the third time it is tracked; S4 tracks once.
    const slow = (calls: Calls) => {
      const inner = courier({}, calls)
      return {
        ...inner,
        capabilities: {
          ...inner.capabilities,
          'shipments.track': async (_ctx: CapabilityContext, externalIds: string[]) => {
            calls.track.push(externalIds)
            return externalIds.map((externalId) => state(calls.track.filter((ids) => ids.length > 0).length >= 3 ? 'ready' : 'pending', externalId))
          },
          'shipments.label': async (_ctx: CapabilityContext, { externalId }: { externalId: string }) => {
            calls.label.push(externalId)
            if (calls.track.filter((ids) => ids.length > 0).length < 3) throw new TransientError('no label yet')
            return { contentType: 'application/pdf', data: new Uint8Array([1]) }
          },
        },
      } satisfies AnyConnectorDefinition
    }
    const calls: Calls = { create: [], track: [], label: [], cancel: [] }
    await expect(assertConformance(slow(calls), { ...fixtures, unauthorized: undefined, forbidden: false })).resolves.toBeUndefined()
    expect(calls.label).toHaveLength(3)
    expect(calls.track).toEqual([['ext-1'], [], ['ext-1'], ['ext-1']])

    const impatient = { ...fixtures, unauthorized: undefined, shipment: { request, labelAttempts: 2 } }
    await expect(assertConformance(slow({ create: [], track: [], label: [], cancel: [] }), impatient)).rejects.toThrow(
      /\[S5\] shipments\.label still failed as 'transient' after 2 attempts/,
    )
  })

  it('accepts a cancel that is refused both times', async () => {
    const tooLate = withCapabilities(() => ({ 'shipments.cancel': async () => ({ outcome: 'refused', code: 'too_late' }) }))
    await expect(assertConformance(tooLate, fixtures)).resolves.toBeUndefined()
  })

  it('accepts a Buffer as the Label file and a cash-on-delivery request for a service that takes it', async () => {
    const buffered = withCapabilities(() => ({ 'shipments.label': async () => ({ contentType: 'application/pdf', data: Buffer.from('%PDF-1.4') }) }))
    const cod = { ...request, cashOnDelivery: { amount: '49.99', currency: 'PLN' } }
    await expect(assertConformance(buffered, { ...fixtures, shipment: { request: cod } })).resolves.toBeUndefined()
  })

  it('runs C11 and C14 against shipments.track for a connector without orders.pull', async () => {
    const seen: Array<{ apiKey: string; ids: string[] }> = []
    const watched = withCapabilities((inner) => ({
      'shipments.track': async (ctx, externalIds) => {
        seen.push({ apiKey: (ctx.credentials as { apiKey: string }).apiKey, ids: externalIds })
        return inner['shipments.track']!(ctx, externalIds)
      },
    }))
    await expect(assertConformance(watched, fixtures)).resolves.toBeUndefined()
    expect(seen).toContainEqual({ apiKey: 'expired', ids: ['ext-1'] })

    await expect(assertConformance(httpCourier(), httpFixtures)).resolves.toBeUndefined()
    const signsOutWith403 = httpCourier({ isAuthFailure: (response) => response.status === 403 })
    await expect(assertConformance(signsOutWith403, { ...httpFixtures, forbidden: false })).resolves.toBeUndefined()
  })

  it('keeps C11 on orders.pull for a Channel that makes Shipments too', async () => {
    const tracked: string[] = []
    const order: Order = {
      externalId: 'a',
      placedAt: '2026-10-01T09:00:00Z',
      payment: 'prepaid',
      total: { amount: '10.00', currency: 'PLN' },
      buyer: { name: 'John', email: null, phone: null, login: null },
      shippingAddress: { name: 'John', company: null, street: '1 Test Street', postalCode: '00-001', city: 'Warsaw', countryCode: 'PL', phone: null, taxId: null },
      billingAddress: null,
      delivery: { method: 'Locker', pickupPoint: { id: 'KRA010', name: null } },
      lines: [{ externalId: 'l1', offerExternalId: 'o1', sku: 'SKU-1', name: 'Mug', quantity: 1, unitPrice: { amount: '10.00', currency: 'PLN' } }],
      facts: [],
    }
    const inner = courier()
    const channel: AnyConnectorDefinition = {
      ...inner,
      kind: 'marketplace',
      capabilities: {
        ...inner.capabilities,
        'offers.pull': async () => ({ items: [{ externalId: 'o1', sku: 'SKU-1', name: 'Mug', url: null }], nextCursor: '1', hasMore: false }),
        'orders.pull': async (ctx, cursor) => {
          if ((ctx.credentials as { apiKey: string }).apiKey === 'expired') throw new AuthExpiredError('expired')
          return { items: cursor === null ? [order] : [], nextCursor: '1', hasMore: false }
        },
        'stock.push': async () => {},
        'shipments.track': async (ctx, externalIds) => {
          tracked.push((ctx.credentials as { apiKey: string }).apiKey)
          return inner.capabilities['shipments.track']!(ctx, externalIds)
        },
      },
    }
    await expect(assertConformance(channel, fixtures)).resolves.toBeUndefined()
    expect(tracked).not.toContain('expired')
    // S4 twice and nothing else: C14 is on the pulls.
    expect(tracked).toEqual(['test', 'test'])
  })

  it.each(broken)('%s fails for %s', async (ids, _what, connector, override) => {
    const error = await assertConformance(connector, override ?? fixtures).then(
      () => null,
      (reason: unknown) => reason as Error,
    )
    expect(error, `expected ${ids.join(', ')} to fail`).toBeInstanceOf(Error)
    expect(failedChecks(error!)).toEqual(ids)
  })

  it('says what is wrong in words a connector author can act on', async () => {
    const message = async (connector: AnyConnectorDefinition, override: ConformanceFixtures = fixtures) =>
      ((await assertConformance(connector, override).catch((reason: Error) => reason)) as Error).message
    expect(await message(courier({ shipping: { services: [locker, { ...door, id: 'locker' }] } }))).toContain('[S1] shipping service "locker" is declared twice')
    expect(await message(courier(), { ...fixtures, shipment: { request: { ...request, service: 'door' } } })).toContain(
      '[S2] the shipment request fixture does not fit the service "door" (destination_type); the core never sends such a request',
    )
    expect(await message(httpCourier({}, true), httpFixtures)).toContain('[S4] shipments.track of no Shipments made a request')
    expect(await message(withCapabilities(() => ({ 'shipments.label': async () => ({ contentType: 'application/pdf', data: new Uint8Array() }) })))).toMatch(
      /\[S5\] shipments\.label returned an invalid Label[\s\S]*expected a non-empty Uint8Array/,
    )
    expect(await message(withCapabilities(() => ({ 'shipments.create': async () => { throw new Error('plain error') } })), { ...fixtures, shipment: { request } })).toContain(
      '[C12] shipments.create rejected with Error: plain error; capabilities must reject with a ConnectorError',
    )
  })
})
