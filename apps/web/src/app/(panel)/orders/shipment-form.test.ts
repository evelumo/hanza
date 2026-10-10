import type { ShippingService } from '@hanza/connector-sdk'
import { shipmentInputSchema } from '@hanza/core'
import { describe, expect, it } from 'vitest'
import { createShipmentSchema, shipmentActionSchema } from './schemas'
import { shipmentFormSchema } from './shipment-form'

const locker: ShippingService = {
  id: 'locker',
  name: 'Locker',
  destination: 'pickup_point',
  parcel: { type: 'presets', presets: [{ id: 'small', name: 'Small' }, { id: 'large', name: 'Large' }] },
  cashOnDelivery: true,
}
const courier: ShippingService = { id: 'courier', name: 'Courier', destination: 'address', parcel: { type: 'dimensions' }, cashOnDelivery: true }
const noCod: ShippingService = { ...courier, id: 'plain', cashOnDelivery: false }
const dimensions = { lengthCm: '30,5', widthCm: '20', heightCm: '8.1', weightKg: '0.3' }

const issues = (result: ReturnType<ReturnType<typeof shipmentFormSchema>['safeParse']>) =>
  result.success ? {} : Object.fromEntries(result.error.issues.map((issue) => [String(issue.path[0]), issue.message]))

describe('createShipmentSchema', () => {
  it('takes the ids every form sends, and says which choice is missing', () => {
    expect(createShipmentSchema.parse({ orderId: 'o1', connectionId: 'c1', service: 'inpost_locker_standard', pickupPoint: 'KRA010' })).toEqual({
      orderId: 'o1',
      connectionId: 'c1',
      service: 'inpost_locker_standard',
    })
    const missing = createShipmentSchema.safeParse({ orderId: 'o1', connectionId: '', service: '' })
    expect(missing.success ? [] : missing.error.issues.map((issue) => [issue.path[0], issue.message])).toEqual([
      ['connectionId', 'validation.carrierRequired'],
      ['service', 'validation.serviceRequired'],
    ])
    expect(shipmentActionSchema.safeParse({}).success).toBe(false)
    expect(shipmentActionSchema.parse({ shipmentId: 's1', organizationId: 'other' })).toEqual({ shipmentId: 's1' })
  })
})

describe('shipmentFormSchema', () => {
  it('reads a preset and a pickup point for a service that takes them', () => {
    expect(shipmentFormSchema(locker, null).parse({ preset: 'large', pickupPoint: '  KRA010 ' })).toEqual({
      parcel: { preset: 'large' },
      destination: { type: 'pickup_point', pointId: 'KRA010' },
      cashOnDelivery: null,
    })
  })

  it('reads dimensions in centimetres and a weight in kilograms as whole millimetres and grams', () => {
    expect(shipmentFormSchema(courier, null).parse(dimensions)).toEqual({
      parcel: { lengthMm: 305, widthMm: 200, heightMm: 81, weightGrams: 300 },
      destination: { type: 'address' },
      cashOnDelivery: null,
    })
  })

  it('ignores the fields of another service: a parcel is a preset or dimensions, never both', () => {
    const parsed = shipmentFormSchema(courier, null).parse({ ...dimensions, preset: 'large', pickupPoint: 'KRA010' })
    expect(parsed.parcel).toEqual({ lengthMm: 305, widthMm: 200, heightMm: 81, weightGrams: 300 })
    expect(parsed.destination).toEqual({ type: 'address' })
  })

  it('says which field is wrong, with a message key', () => {
    expect(issues(shipmentFormSchema(locker, null).safeParse({ preset: 'huge', pickupPoint: ' ' }))).toEqual({
      preset: 'validation.presetRequired',
      pickupPoint: 'validation.pickupPointRequired',
    })
    expect(issues(shipmentFormSchema(locker, null).safeParse({}))).toEqual({
      preset: 'validation.presetRequired',
      pickupPoint: 'validation.pickupPointRequired',
    })
    expect(issues(shipmentFormSchema(locker, null).safeParse({ preset: 'small', pickupPoint: 'K'.repeat(101) }))).toEqual({
      pickupPoint: 'validation.pickupPointTooLong',
    })
    expect(issues(shipmentFormSchema(courier, null).safeParse({ lengthCm: '0', widthCm: '20.55', heightCm: '', weightKg: 'heavy' }))).toEqual({
      lengthCm: 'validation.dimensionInvalid',
      widthCm: 'validation.dimensionInvalid',
      heightCm: 'validation.dimensionInvalid',
      weightKg: 'validation.weightInvalid',
    })
  })

  it('reads the amount to collect only for a cash-on-delivery Order and a service that collects', () => {
    const pln = shipmentFormSchema(courier, 'PLN')
    expect(pln.parse({ ...dimensions, cashOnDelivery: '84,00' }).cashOnDelivery).toEqual({ amount: '84.00', currency: 'PLN' })
    expect(pln.parse({ ...dimensions, cashOnDelivery: ' ' }).cashOnDelivery).toBeNull()
    expect(pln.parse(dimensions).cashOnDelivery).toBeNull()
    // A prepaid Order, or a service without it: whatever was sent is not read.
    expect(shipmentFormSchema(courier, null).parse({ ...dimensions, cashOnDelivery: '84.00' }).cashOnDelivery).toBeNull()
    expect(shipmentFormSchema(noCod, 'PLN').parse({ ...dimensions, cashOnDelivery: 'nonsense' }).cashOnDelivery).toBeNull()
  })

  it('refuses an amount that is not money of the Order’s currency', () => {
    const pln = shipmentFormSchema(courier, 'PLN')
    expect(issues(pln.safeParse({ ...dimensions, cashOnDelivery: 'abc' }))).toEqual({ cashOnDelivery: 'validation.codAmountInvalid' })
    expect(issues(pln.safeParse({ ...dimensions, cashOnDelivery: '0' }))).toEqual({ cashOnDelivery: 'validation.codAmountInvalid' })
    expect(issues(pln.safeParse({ ...dimensions, cashOnDelivery: '84.0055' }))).toEqual({ cashOnDelivery: 'validation.priceTooManyDecimals' })
    expect(issues(pln.safeParse({ ...dimensions, cashOnDelivery: '1.234' }))).toEqual({ cashOnDelivery: 'validation.priceAmbiguous' })
    expect(issues(shipmentFormSchema(courier, 'JPY').safeParse({ ...dimensions, cashOnDelivery: '84.5' }))).toEqual({
      cashOnDelivery: 'validation.priceTooManyDecimals',
    })
  })

  it('makes what the core accepts as a Shipment request', () => {
    for (const [service, fields] of [
      [locker, { preset: 'small', pickupPoint: 'KRA010', cashOnDelivery: '12.50' }],
      [courier, { ...dimensions, cashOnDelivery: '' }],
    ] as const) {
      const input = { connectionId: 'c1', service: service.id, ...shipmentFormSchema(service, 'PLN').parse(fields) }
      expect(shipmentInputSchema.safeParse(input).success, service.id).toBe(true)
    }
  })
})
