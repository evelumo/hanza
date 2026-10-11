import {
  PermanentError,
  TransientError,
  listCapabilities,
  orderSchema,
  shipmentCancelResultSchema,
  shipmentCreateResultSchema,
  shipmentLabelSchema,
  shipmentRequestProblem,
  shipmentRequestSchema,
  shipmentStateSchema,
  type CapabilityContext,
  type ShipmentRequest,
  type ShipmentState,
} from '@hanza/connector-sdk'
import { assertConformance } from '@hanza/connector-sdk/testing'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  FAKE_COURIER_PHONE_MISSING,
  FAKE_COURIER_PICKUP_POINT_UNKNOWN,
  FAKE_COURIER_SHIPMENT_UNKNOWN,
  FAKE_COURIER_TOO_LATE,
  createFakeChannel,
  createFakeCourier,
  fakeCourier,
  fakeCourierConfigSchema,
  fakeCourierConnector,
  fakeCourierServices,
} from './index'
import { SEED_PHONE, seedOrders } from './seed'

type Config = z.input<typeof fakeCourierConfigSchema>
type CourierContext = CapabilityContext<z.output<typeof fakeCourierConfigSchema>, Record<string, never>>

const context = (config: Config = {}): CourierContext => ({
  app: {},
  config: fakeCourierConfigSchema.parse(config),
  credentials: {},
  fetch: async () => {
    throw new Error('the fake courier never uses the network')
  },
  log: () => {},
})

const request = (overrides: Partial<ShipmentRequest> = {}): ShipmentRequest => ({
  reference: 'shp_1',
  requestedAt: '2026-10-10T09:00:00Z',
  service: 'locker',
  receiver: { name: 'John Test', company: null, email: 'john.test@example.com', phone: '600100200' },
  destination: { type: 'pickup_point', pointId: 'FAKE01' },
  parcel: { preset: 'small' },
  cashOnDelivery: null,
  ...overrides,
})

const toDoor = (overrides: Partial<ShipmentRequest> = {}): ShipmentRequest =>
  request({
    service: 'courier',
    destination: {
      type: 'address',
      address: { name: 'John Test', company: null, street: '1 Example Street', postalCode: '00-001', city: 'Warsaw', countryCode: 'PL', phone: null, taxId: null },
    },
    parcel: { lengthMm: 300, widthMm: 200, heightMm: 100, weightGrams: 1500 },
    ...overrides,
  })

/** One fake Carrier with its capabilities called the way the core calls them. */
function carrier(config: Config = {}) {
  const courier = createFakeCourier()
  const { capabilities } = courier.connector
  const ctx = (override: Config = config) => context(override)
  return {
    courier,
    create: async (shipmentRequest: ShipmentRequest, override?: Config) => shipmentCreateResultSchema.parse(await capabilities['shipments.create']!(ctx(override), shipmentRequest)),
    track: async (ids: string[], override?: Config) => z.array(shipmentStateSchema).parse(await capabilities['shipments.track']!(ctx(override), ids)),
    label: (externalId: string, override?: Config) => capabilities['shipments.label']!(ctx(override), { externalId }),
    cancel: async (externalId: string, override?: Config) => shipmentCancelResultSchema.parse(await capabilities['shipments.cancel']!(ctx(override), { externalId })),
  }
}

/** The state of a Shipment `create` made; fails the test when it was refused. */
async function created(fake: ReturnType<typeof carrier>, shipmentRequest: ShipmentRequest = request(), override?: Config): Promise<ShipmentState> {
  const result = await fake.create(shipmentRequest, override)
  if (result.outcome !== 'created') throw new Error(`expected a created Shipment, got "${result.code}"`)
  const { outcome: _outcome, ...state } = result
  return state
}

describe('fake courier', () => {
  it('passes the conformance kit', async () => {
    await assertConformance(createFakeCourier().connector, {
      config: { rejectPickupPoints: 'FAKE-NOPE' },
      credentials: {},
      shipment: { request: request(), rejected: { request: request({ reference: 'shp_2', destination: { type: 'pickup_point', pointId: 'FAKE-NOPE' } }) } },
    })
  })

  it('passes the kit for an address service too', async () => {
    await assertConformance(createFakeCourier().connector, {
      config: {},
      credentials: {},
      shipment: { request: toDoor(), rejected: { request: request({ reference: 'shp_2', receiver: { ...request().receiver, phone: null } }) } },
    })
  })

  it('is a courier without credentials, registered as `fake-courier`', () => {
    expect(fakeCourierConnector).toBe(fakeCourier.connector)
    expect(fakeCourierConnector.id).toBe('fake-courier')
    expect(fakeCourierConnector.kind).toBe('courier')
    expect(fakeCourierConnector.auth).toEqual({ type: 'none' })
    expect(listCapabilities(fakeCourierConnector)).toEqual(['shipments.create', 'shipments.track', 'shipments.label', 'shipments.cancel'])
  })

  it('offers a locker with three presets and an address service with dimensions, both with cash on delivery', () => {
    expect(fakeCourierConnector.shipping?.services.map((service) => [service.id, service.destination, service.cashOnDelivery])).toEqual([
      ['locker', 'pickup_point', true],
      ['courier', 'address', true],
    ])
    const [locker, courier] = fakeCourierServices
    expect(locker!.parcel).toMatchObject({ type: 'presets' })
    expect(locker!.parcel.type === 'presets' && locker!.parcel.presets.map((preset) => preset.id)).toEqual(['small', 'medium', 'large'])
    expect(courier!.parcel).toEqual({ type: 'dimensions' })
    expect(shipmentRequestProblem(locker!, request())).toBeNull()
    expect(shipmentRequestProblem(courier!, toDoor())).toBeNull()
  })

  it('takes every config field from the form, with defaults', () => {
    expect(fakeCourierConfigSchema.parse({})).toEqual({ account: 'default', rejectPickupPoints: '', stuckAt: 'none' })
  })

  describe('shipments.create', () => {
    it('makes a pending Shipment with a deterministic tracking number', async () => {
      const fake = carrier()
      expect(await created(fake)).toEqual({ externalId: 'fake-shipment-000001', status: 'pending', trackingNumber: 'FAKE000001', carrierStatus: 'created' })
      expect(await created(fake, toDoor({ reference: 'shp_2' }))).toMatchObject({ externalId: 'fake-shipment-000002', trackingNumber: 'FAKE000002' })
      expect(fake.courier.shipments.map((shipment) => shipment.reference)).toEqual(['shp_1', 'shp_2'])
    })

    it('returns the Shipment as it is now for a repeated reference, across separate calls, and makes nothing', async () => {
      const fake = carrier()
      const first = await created(fake)
      await fake.track([first.externalId])
      expect(await created(fake)).toEqual({ ...first, status: 'ready', carrierStatus: 'confirmed' })
      expect(fake.courier.shipments).toHaveLength(1)
      expect(fake.courier.creates).toHaveLength(2)
    })

    it('refuses a pickup point from rejectPickupPoints and makes nothing', async () => {
      const fake = carrier({ rejectPickupPoints: 'FAKE-NOPE, FAKE-GONE' })
      expect(await fake.create(request({ destination: { type: 'pickup_point', pointId: 'FAKE-GONE' } }))).toEqual({
        outcome: 'rejected',
        code: FAKE_COURIER_PICKUP_POINT_UNKNOWN,
      })
      expect(fake.courier.shipments).toEqual([])
      expect((await fake.create(request())).outcome).toBe('created')
    })

    it('refuses a pickup point request whose receiver has no phone, but not a delivery to an address', async () => {
      const fake = carrier()
      const noPhone = { ...request().receiver, phone: null }
      expect(await fake.create(request({ receiver: noPhone }))).toEqual({ outcome: 'rejected', code: FAKE_COURIER_PHONE_MISSING })
      expect((await fake.create(toDoor({ reference: 'shp_2', receiver: noPhone }))).outcome).toBe('created')
    })

    it('refuses with codes a Shipment may carry', () => {
      for (const code of [FAKE_COURIER_PICKUP_POINT_UNKNOWN, FAKE_COURIER_PHONE_MISSING, FAKE_COURIER_TOO_LATE, FAKE_COURIER_SHIPMENT_UNKNOWN]) {
        expect(code).toMatch(/^[A-Za-z0-9_.:-]{1,100}$/)
      }
    })

    it('records the requests it was sent', async () => {
      const fake = carrier()
      await fake.create(request())
      expect(fake.courier.creates).toEqual([request()])
      expect(shipmentRequestSchema.safeParse(fake.courier.creates[0]).success).toBe(true)
    })
  })

  describe('shipments.track', () => {
    it('advances a Shipment one step each call: pending, ready, in_transit, delivered', async () => {
      const fake = carrier()
      const { externalId } = await created(fake)
      const seen: Array<[string, string | null, string | null]> = []
      for (let call = 0; call < 5; call++) {
        const [state] = await fake.track([externalId])
        seen.push([state!.status, state!.carrierStatus, state!.trackingNumber])
      }
      expect(seen).toEqual([
        ['ready', 'confirmed', 'FAKE000001'],
        ['in_transit', 'collected', 'FAKE000001'],
        ['delivered', 'delivered', 'FAKE000001'],
        ['delivered', 'delivered', 'FAKE000001'],
        ['delivered', 'delivered', 'FAKE000001'],
      ])
    })

    it('advances only the Shipments it is asked about, and each once even when listed twice', async () => {
      const fake = carrier()
      const a = await created(fake)
      const b = await created(fake, request({ reference: 'shp_2' }))
      expect((await fake.track([a.externalId, a.externalId])).map((state) => [state.externalId, state.status])).toEqual([[a.externalId, 'ready']])
      expect((await fake.track([b.externalId, a.externalId])).map((state) => [state.externalId, state.status])).toEqual([
        [b.externalId, 'ready'],
        [a.externalId, 'in_transit'],
      ])
    })

    it('answers an empty list with an empty list, and leaves an unknown id out', async () => {
      const fake = carrier()
      expect(await fake.track([])).toEqual([])
      expect(fake.courier.tracks).toEqual([])
      expect(await fake.track(['fake-shipment-999999'])).toEqual([])
    })

    it.each([
      ['pending', 'pending'],
      ['ready', 'ready'],
      ['in_transit', 'in_transit'],
    ] as const)('holds every Shipment at stuckAt %s once it reaches it', async (stuckAt, expected) => {
      const fake = carrier({ stuckAt })
      const a = await created(fake)
      const b = await created(fake, request({ reference: 'shp_2' }))
      for (let call = 0; call < 5; call++) await fake.track([a.externalId, b.externalId])
      expect((await fake.track([a.externalId, b.externalId])).map((state) => state.status)).toEqual([expected, expected])
    })

    it('lets a Shipment move on again when stuckAt is set back to none', async () => {
      const fake = carrier({ stuckAt: 'ready' })
      const { externalId } = await created(fake)
      await fake.track([externalId])
      expect((await fake.track([externalId]))[0]!.status).toBe('ready')
      expect((await fake.track([externalId], { stuckAt: 'none' }))[0]!.status).toBe('in_transit')
    })

    it('never moves a cancelled Shipment', async () => {
      const fake = carrier()
      const { externalId } = await created(fake)
      await fake.cancel(externalId)
      expect(await fake.track([externalId])).toEqual([{ externalId, status: 'cancelled', trackingNumber: 'FAKE000001', carrierStatus: 'cancelled' }])
    })
  })

  describe('shipments.label', () => {
    it('is not there while the Shipment is pending: a transient failure', async () => {
      const fake = carrier()
      const { externalId } = await created(fake)
      await expect(fake.label(externalId)).rejects.toBeInstanceOf(TransientError)
      expect(fake.courier.labels).toEqual([externalId])
    })

    it('is a one-page PDF from ready on, without Buyer data', async () => {
      const fake = carrier()
      const { externalId } = await created(fake)
      await fake.track([externalId])
      const label = shipmentLabelSchema.parse(await fake.label(externalId))
      expect(label.contentType).toBe('application/pdf')
      const text = new TextDecoder().decode(label.data)
      expect(text.startsWith('%PDF-1.4\n')).toBe(true)
      expect(text.trimEnd().endsWith('%%EOF')).toBe(true)
      expect(text.match(/\/Type \/Page\b/g)).toHaveLength(1)
      expect(text).toContain('FAKE000001')
      for (const personal of ['John', 'Test', 'example', '600100200']) expect(text).not.toContain(personal)
      // The cross-reference table points at the objects.
      const xref = Number(/startxref\n(\d+)/.exec(text)![1])
      expect(text.slice(xref, xref + 4)).toBe('xref')
      const offsets = [...text.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]))
      offsets.forEach((offset, index) => expect(text.slice(offset).startsWith(`${index + 1} 0 obj`)).toBe(true))
      expect(offsets).toHaveLength(5)
    })

    it('is available for as long as the Carrier keeps the Shipment', async () => {
      const fake = carrier()
      const { externalId } = await created(fake)
      for (let call = 0; call < 3; call++) await fake.track([externalId])
      await expect(fake.label(externalId)).resolves.toMatchObject({ contentType: 'application/pdf' })
    })

    it('fails for good for a Shipment it does not know', async () => {
      await expect(carrier().label('fake-shipment-999999')).rejects.toBeInstanceOf(PermanentError)
    })
  })

  describe('shipments.cancel', () => {
    it('cancels a pending Shipment and a ready one', async () => {
      const fake = carrier()
      const pending = await created(fake)
      const ready = await created(fake, request({ reference: 'shp_2' }))
      await fake.track([ready.externalId])
      expect(await fake.cancel(pending.externalId)).toEqual({ outcome: 'cancelled' })
      expect(await fake.cancel(ready.externalId)).toEqual({ outcome: 'cancelled' })
      expect(fake.courier.shipments.map((shipment) => shipment.status)).toEqual(['cancelled', 'cancelled'])
    })

    it('says cancelled again for a Shipment it cancelled', async () => {
      const fake = carrier()
      const { externalId } = await created(fake)
      await fake.cancel(externalId)
      expect(await fake.cancel(externalId)).toEqual({ outcome: 'cancelled' })
      expect(fake.courier.cancels).toEqual([externalId, externalId])
    })

    it('refuses a Shipment it does not know: nothing says that parcel was cancelled', async () => {
      const fake = carrier()
      expect(await fake.cancel('fake-shipment-999999')).toEqual({ outcome: 'refused', code: FAKE_COURIER_SHIPMENT_UNKNOWN })
      expect(await fake.cancel('fake-shipment-999999')).toEqual({ outcome: 'refused', code: FAKE_COURIER_SHIPMENT_UNKNOWN })
      expect(fake.courier.cancels).toEqual(['fake-shipment-999999', 'fake-shipment-999999'])
      expect(fake.courier.shipments).toEqual([])
    })

    it('refuses with too_late once the Carrier has the parcel', async () => {
      const fake = carrier()
      const { externalId } = await created(fake)
      await fake.track([externalId])
      await fake.track([externalId])
      expect(await fake.cancel(externalId)).toEqual({ outcome: 'refused', code: FAKE_COURIER_TOO_LATE })
      await fake.track([externalId])
      expect(await fake.cancel(externalId)).toEqual({ outcome: 'refused', code: FAKE_COURIER_TOO_LATE })
      expect(fake.courier.shipments[0]!.status).toBe('delivered')
    })

    it('can cancel a Shipment held at ready by stuckAt, as a demo needs', async () => {
      const fake = carrier({ stuckAt: 'ready' })
      const { externalId } = await created(fake)
      for (let call = 0; call < 3; call++) await fake.track([externalId])
      expect(await fake.cancel(externalId)).toEqual({ outcome: 'cancelled' })
    })
  })

  describe('state', () => {
    it('is kept per Carrier account: another account neither sees nor changes a Shipment', async () => {
      const fake = carrier()
      const mine = await created(fake, request(), { account: 'one' })
      expect(await fake.track([mine.externalId], { account: 'two' })).toEqual([])
      expect(await fake.cancel(mine.externalId, { account: 'two' })).toEqual({ outcome: 'refused', code: FAKE_COURIER_SHIPMENT_UNKNOWN })
      await expect(fake.label(mine.externalId, { account: 'two' })).rejects.toBeInstanceOf(PermanentError)
      expect((await fake.track([mine.externalId], { account: 'one' }))[0]!.status).toBe('ready')
      // The same reference on another account is another Shipment.
      const theirs = await created(fake, request(), { account: 'two' })
      expect(theirs.externalId).not.toBe(mine.externalId)
      expect(fake.courier.shipments.map((shipment) => shipment.account)).toEqual(['one', 'two'])
    })

    it('is not shared between two fake Carriers', async () => {
      const first = carrier()
      const second = carrier()
      await created(first)
      expect(second.courier.shipments).toEqual([])
      expect(await created(second)).toMatchObject({ externalId: 'fake-shipment-000001' })
    })

    it('can run under another id', () => {
      expect(createFakeCourier({ id: 'fake-courier-2' }).connector.id).toBe('fake-courier-2')
    })

    it('records every call and goes back to empty on reset, keeping the arrays', async () => {
      const fake = carrier()
      const { shipments, creates, tracks, labels, cancels } = fake.courier
      const { externalId } = await created(fake)
      await fake.track([externalId])
      await fake.label(externalId)
      await fake.cancel(externalId)
      expect([shipments.length, creates.length, tracks, labels, cancels]).toEqual([1, 1, [[externalId]], [externalId], [externalId]])
      fake.courier.reset()
      expect([shipments, creates, tracks, labels, cancels]).toEqual([[], [], [], [], []])
      expect(fake.courier.shipments).toBe(shipments)
      expect(await created(fake)).toMatchObject({ externalId: 'fake-shipment-000001' })
    })
  })
})

describe('seed Delivery', () => {
  it('has Orders that still satisfy the schema', () => {
    expect(seedOrders.map((order) => order.externalId)).toEqual(['fake-order-1', 'fake-order-2', 'fake-order-3', 'fake-order-4'])
    seedOrders.forEach((order) => expect(orderSchema.parse(order)).toEqual(order))
  })

  it('has a pickup point, a courier and an Order whose Channel does not say', () => {
    const delivery = Object.fromEntries(seedOrders.map((order) => [order.externalId, order.delivery]))
    expect(delivery['fake-order-1']).toEqual({ method: 'Parcel locker', pickupPoint: { id: 'FAKE01', name: expect.any(String) } })
    expect(delivery['fake-order-4']).toMatchObject({ pickupPoint: { id: 'FAKE02' } })
    expect(delivery['fake-order-2']).toEqual({ method: 'Courier, cash on delivery', pickupPoint: null })
    expect('delivery' in seedOrders.find((order) => order.externalId === 'fake-order-3')!).toBe(false)
  })

  it('gives the Orders that go to a pickup point a phone, which the locker service needs, and leaves the others without', async () => {
    const phones = Object.fromEntries(seedOrders.map((order) => [order.externalId, [order.buyer.phone, order.shippingAddress.phone]]))
    expect(phones).toEqual({
      'fake-order-1': [SEED_PHONE, SEED_PHONE],
      'fake-order-2': [null, null],
      'fake-order-3': [null, null],
      'fake-order-4': [SEED_PHONE, SEED_PHONE],
    })
    // What the core sends for them: the phone of the shipping address, else the Buyer's.
    const fake = carrier()
    const toLocker = (order: (typeof seedOrders)[number], reference: string) =>
      fake.create(request({ reference, receiver: { ...request().receiver, phone: order.shippingAddress.phone ?? order.buyer.phone } }))
    expect((await toLocker(seedOrders[0]!, 'shp_seed_1')).outcome).toBe('created')
    expect(await toLocker(seedOrders[2]!, 'shp_seed_3')).toEqual({ outcome: 'rejected', code: FAKE_COURIER_PHONE_MISSING })
  })

  it('is what the fake Channel pulls', async () => {
    const page = await createFakeChannel().connector.capabilities['orders.pull']!(
      { app: {}, config: { failMode: 'none', rejectOffers: '' }, credentials: { apiKey: 'test' }, fetch, log: () => {} },
      null,
    )
    expect(page.items[0]).toMatchObject({ externalId: 'fake-order-1', delivery: { pickupPoint: { id: 'FAKE01' } } })
  })
})
