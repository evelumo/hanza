import { describe, expect, it } from 'vitest'
import {
  FINAL_SHIPMENT_STATUSES,
  HANDED_OVER_SHIPMENT_STATUSES,
  isFinalShipmentStatus,
  isShipmentHandedOver,
  shipmentCancelResultSchema,
  shipmentCreateResultSchema,
  shipmentLabelSchema,
  shipmentRequestProblem,
  shipmentRequestSchema,
  shipmentStateSchema,
  shipmentStatusSchema,
  shippingServiceSchema,
  SHIPMENT_STATUSES,
  type ShipmentRequest,
  type ShippingService,
} from './shipment'

const address = {
  name: 'John Test',
  company: null,
  street: '1 Example Street',
  postalCode: '00-001',
  city: 'Warsaw',
  countryCode: 'PL',
  phone: null,
  taxId: null,
}

const request: ShipmentRequest = {
  reference: 'shp_1',
  requestedAt: '2026-10-10T09:00:00Z',
  service: 'locker',
  receiver: { name: 'John Test', company: null, email: 'john@example.com', phone: '600100200' },
  destination: { type: 'pickup_point', pointId: 'KRA010' },
  parcel: { preset: 'small' },
  cashOnDelivery: null,
}
const dimensions = { lengthMm: 300, widthMm: 200, heightMm: 100, weightGrams: 1500 }

const state = { externalId: '123', status: 'pending', trackingNumber: null, carrierStatus: 'created' }

describe('Shipment statuses', () => {
  it('is the fixed list of nine', () => {
    expect(SHIPMENT_STATUSES).toEqual([
      'pending',
      'ready',
      'in_transit',
      'awaiting_pickup',
      'delivery_problem',
      'delivered',
      'returned',
      'cancelled',
      'failed',
    ])
    expect(shipmentStatusSchema.safeParse('ready').success).toBe(true)
    expect(shipmentStatusSchema.safeParse('requested').success).toBe(false)
    expect(shipmentStatusSchema.safeParse('shipped').success).toBe(false)
  })

  it('knows which statuses are final', () => {
    expect(SHIPMENT_STATUSES.filter(isFinalShipmentStatus)).toEqual(['delivered', 'returned', 'cancelled', 'failed'])
    expect([...FINAL_SHIPMENT_STATUSES].sort()).toEqual(['cancelled', 'delivered', 'failed', 'returned'])
  })

  it('knows which statuses mean the Carrier has or had the parcel; a printed Label is not one', () => {
    expect(SHIPMENT_STATUSES.filter(isShipmentHandedOver)).toEqual(['in_transit', 'awaiting_pickup', 'delivery_problem', 'delivered', 'returned'])
    expect(HANDED_OVER_SHIPMENT_STATUSES).toHaveLength(5)
    for (const status of ['pending', 'ready', 'cancelled', 'failed'] as const) expect(isShipmentHandedOver(status)).toBe(false)
  })
})

describe('shipmentRequestSchema', () => {
  it('accepts a pickup point with a preset, and an address with dimensions and cash on delivery', () => {
    expect(shipmentRequestSchema.parse(request)).toEqual(request)
    const courier = {
      ...request,
      service: 'courier',
      receiver: { name: 'John Test', company: 'Test Ltd', email: null, phone: null },
      destination: { type: 'address', address },
      parcel: dimensions,
      cashOnDelivery: { amount: '129.99', currency: 'PLN' },
    }
    expect(shipmentRequestSchema.parse(courier)).toEqual(courier)
  })

  it('needs a reference, a service and a datetime with an offset', () => {
    expect(shipmentRequestSchema.safeParse({ ...request, reference: '' }).success).toBe(false)
    expect(shipmentRequestSchema.safeParse({ ...request, service: '' }).success).toBe(false)
    expect(shipmentRequestSchema.safeParse({ ...request, requestedAt: '2026-10-10T09:00:00' }).success).toBe(false)
    expect(shipmentRequestSchema.safeParse({ ...request, requestedAt: '2026-10-10T11:00:00+02:00' }).success).toBe(true)
  })

  it('needs a named receiver whose other fields are null or non-empty', () => {
    expect(shipmentRequestSchema.safeParse({ ...request, receiver: { ...request.receiver, name: '' } }).success).toBe(false)
    expect(shipmentRequestSchema.safeParse({ ...request, receiver: { ...request.receiver, phone: '' } }).success).toBe(false)
    expect(shipmentRequestSchema.safeParse({ ...request, receiver: { name: 'John Test' } }).success).toBe(false)
  })

  it('tells the destinations apart by type', () => {
    expect(shipmentRequestSchema.safeParse({ ...request, destination: { type: 'pickup_point', pointId: '' } }).success).toBe(false)
    expect(shipmentRequestSchema.safeParse({ ...request, destination: { type: 'pickup_point', address } }).success).toBe(false)
    expect(shipmentRequestSchema.safeParse({ ...request, destination: { type: 'address', pointId: 'KRA010' } }).success).toBe(false)
    expect(shipmentRequestSchema.safeParse({ ...request, destination: { type: 'address', address: { ...address, countryCode: 'pl' } } }).success).toBe(false)
    expect(shipmentRequestSchema.safeParse({ ...request, destination: { type: 'locker', pointId: 'KRA010' } }).success).toBe(false)
  })

  it('takes a preset or whole positive dimensions, never both and never part', () => {
    expect(shipmentRequestSchema.safeParse({ ...request, parcel: dimensions }).success).toBe(true)
    expect(shipmentRequestSchema.safeParse({ ...request, parcel: { preset: '' } }).success).toBe(false)
    expect(shipmentRequestSchema.safeParse({ ...request, parcel: { preset: 'small', ...dimensions } }).success).toBe(false)
    expect(shipmentRequestSchema.safeParse({ ...request, parcel: { lengthMm: 300, widthMm: 200, heightMm: 100 } }).success).toBe(false)
    for (const bad of [0, -1, 1.5, '300']) {
      expect(shipmentRequestSchema.safeParse({ ...request, parcel: { ...dimensions, lengthMm: bad } }).success).toBe(false)
      expect(shipmentRequestSchema.safeParse({ ...request, parcel: { ...dimensions, weightGrams: bad } }).success).toBe(false)
    }
  })

  it('takes cash on delivery as Money or null, never a float and never absent', () => {
    expect(shipmentRequestSchema.safeParse({ ...request, cashOnDelivery: { amount: 129.99, currency: 'PLN' } }).success).toBe(false)
    const { cashOnDelivery: _removed, ...without } = request
    expect(shipmentRequestSchema.safeParse(without).success).toBe(false)
  })
})

describe('shipmentStateSchema', () => {
  it('accepts a state with and without a tracking number and a Carrier status', () => {
    expect(shipmentStateSchema.parse(state)).toEqual(state)
    expect(shipmentStateSchema.safeParse({ ...state, status: 'in_transit', trackingNumber: '520000012345678901234567', carrierStatus: null }).success).toBe(true)
  })

  it('rejects an empty id, an unknown status and an empty tracking number', () => {
    expect(shipmentStateSchema.safeParse({ ...state, externalId: '' }).success).toBe(false)
    expect(shipmentStateSchema.safeParse({ ...state, status: 'confirmed' }).success).toBe(false)
    expect(shipmentStateSchema.safeParse({ ...state, trackingNumber: '' }).success).toBe(false)
  })

  it('takes the Carrier status as a short code, like a push rejection code, never free text', () => {
    for (const carrierStatus of ['ready_to_pickup', 'offers.unavailable:no_funds', 'A-1']) {
      expect(shipmentStateSchema.safeParse({ ...state, carrierStatus }).success).toBe(true)
    }
    for (const carrierStatus of ['', 'Out for delivery', 'jan@example.com', 'ul. Testowa 1', 'x'.repeat(101), 'DORĘCZONA']) {
      expect(shipmentStateSchema.safeParse({ ...state, carrierStatus }).success).toBe(false)
    }
  })
})

describe('shipment results', () => {
  it('create is a created Shipment with its state, or rejected with a code', () => {
    expect(shipmentCreateResultSchema.parse({ outcome: 'created', ...state })).toEqual({ outcome: 'created', ...state })
    expect(shipmentCreateResultSchema.safeParse({ outcome: 'rejected', code: 'target_point.does_not_exist' }).success).toBe(true)
    expect(shipmentCreateResultSchema.safeParse({ outcome: 'created' }).success).toBe(false)
    expect(shipmentCreateResultSchema.safeParse({ outcome: 'created', ...state, status: 'new' }).success).toBe(false)
    expect(shipmentCreateResultSchema.safeParse({ outcome: 'rejected' }).success).toBe(false)
    expect(shipmentCreateResultSchema.safeParse({ outcome: 'rejected', code: 'The pickup point does not exist' }).success).toBe(false)
    expect(shipmentCreateResultSchema.safeParse({ outcome: 'ok', ...state }).success).toBe(false)
  })

  it('cancel is cancelled, or refused with a code', () => {
    expect(shipmentCancelResultSchema.safeParse({ outcome: 'cancelled' }).success).toBe(true)
    expect(shipmentCancelResultSchema.safeParse({ outcome: 'refused', code: 'too_late' }).success).toBe(true)
    expect(shipmentCancelResultSchema.safeParse({ outcome: 'refused' }).success).toBe(false)
    expect(shipmentCancelResultSchema.safeParse({ outcome: 'refused', code: 'too late' }).success).toBe(false)
    expect(shipmentCancelResultSchema.safeParse({ outcome: 'rejected', code: 'too_late' }).success).toBe(false)
  })

  it('a Label is a content type and a non-empty file, a Buffer included', () => {
    const data = new Uint8Array([0x25, 0x50, 0x44, 0x46])
    expect(shipmentLabelSchema.parse({ contentType: 'application/pdf', data }).data).toBe(data)
    expect(shipmentLabelSchema.safeParse({ contentType: 'application/pdf', data: Buffer.from('%PDF') }).success).toBe(true)
    expect(shipmentLabelSchema.safeParse({ contentType: '', data }).success).toBe(false)
    expect(shipmentLabelSchema.safeParse({ contentType: 'application/pdf', data: new Uint8Array() }).success).toBe(false)
    expect(shipmentLabelSchema.safeParse({ contentType: 'application/pdf', data: 'JVBERg==' }).success).toBe(false)
    expect(shipmentLabelSchema.safeParse({ contentType: 'application/pdf', data: data.buffer }).success).toBe(false)
  })
})

describe('shippingServiceSchema and shipmentRequestProblem', () => {
  const locker: ShippingService = {
    id: 'locker',
    name: 'Locker',
    destination: 'pickup_point',
    parcel: { type: 'presets', presets: [{ id: 'small', name: 'Small' }, { id: 'large', name: 'Large' }] },
    cashOnDelivery: false,
  }
  const courier: ShippingService = { id: 'courier', name: 'Courier', destination: 'address', parcel: { type: 'dimensions' }, cashOnDelivery: true }

  it('accepts a presets service and a dimensions service', () => {
    expect(shippingServiceSchema.parse(locker)).toEqual(locker)
    expect(shippingServiceSchema.parse(courier)).toEqual(courier)
  })

  it('rejects a service without an id, a name, presets or a known destination', () => {
    expect(shippingServiceSchema.safeParse({ ...locker, id: '' }).success).toBe(false)
    expect(shippingServiceSchema.safeParse({ ...locker, name: '' }).success).toBe(false)
    expect(shippingServiceSchema.safeParse({ ...locker, destination: 'locker' }).success).toBe(false)
    expect(shippingServiceSchema.safeParse({ ...locker, parcel: { type: 'presets', presets: [] } }).success).toBe(false)
    expect(shippingServiceSchema.safeParse({ ...locker, parcel: { type: 'presets', presets: [{ id: '', name: 'Small' }] } }).success).toBe(false)
    expect(shippingServiceSchema.safeParse({ ...locker, parcel: { type: 'weight' } }).success).toBe(false)
    expect(shippingServiceSchema.safeParse({ ...locker, cashOnDelivery: 'yes' }).success).toBe(false)
  })

  it('says why a request does not fit a service, and nothing when it fits', () => {
    const toAddress = { ...request, destination: { type: 'address' as const, address }, parcel: dimensions }
    expect(shipmentRequestProblem(locker, request)).toBeNull()
    expect(shipmentRequestProblem(courier, toAddress)).toBeNull()
    expect(shipmentRequestProblem(courier, { ...toAddress, cashOnDelivery: { amount: '10.00', currency: 'PLN' } })).toBeNull()

    expect(shipmentRequestProblem(courier, request)).toBe('destination_type')
    expect(shipmentRequestProblem(locker, { ...request, parcel: dimensions })).toBe('parcel_type')
    expect(shipmentRequestProblem(courier, { ...toAddress, parcel: { preset: 'small' } })).toBe('parcel_type')
    expect(shipmentRequestProblem(locker, { ...request, parcel: { preset: 'medium' } })).toBe('parcel_preset')
    expect(shipmentRequestProblem(locker, { ...request, cashOnDelivery: { amount: '10.00', currency: 'PLN' } })).toBe('cash_on_delivery')
  })
})
