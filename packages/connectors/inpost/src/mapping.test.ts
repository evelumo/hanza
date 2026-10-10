import { PermanentError, type Address, type ShipmentRequest } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import type { ShipxShipment } from './api'
import {
  createRefusalCode,
  formatPostCode,
  gramsToKilograms,
  isNonStandard,
  normalizePhone,
  plnAmount,
  purchaseFailure,
  receiverAddress,
  receiverName,
  rejectionCode,
  shipmentJson,
  toShipmentState,
  toShipxShipment,
} from './mapping'

const config = { lockerSendingMethod: 'any_point', courierSendingMethod: 'dispatch_order' } as const

const lockerRequest: ShipmentRequest = {
  reference: 'shp_locker_1',
  requestedAt: '2026-10-10T09:00:00Z',
  service: 'inpost_locker_standard',
  receiver: { name: 'Jan Kowalski', company: null, email: 'jan.kowalski@example.com', phone: '+48 111 222 333' },
  destination: { type: 'pickup_point', pointId: 'KRA010' },
  parcel: { preset: 'small' },
  cashOnDelivery: null,
}

const address: Address = {
  name: 'Maria Anna Wisniewska',
  company: null,
  street: 'ul. Przykladowa 12/4',
  postalCode: '02677',
  city: 'Warszawa',
  countryCode: 'PL',
  phone: null,
  taxId: null,
}

const courierRequest: ShipmentRequest = {
  reference: 'shp_courier_1',
  requestedAt: '2026-10-10T09:00:00Z',
  service: 'inpost_courier_standard',
  receiver: { name: 'Maria Anna Wisniewska', company: 'Pracownia Przykladowa', email: null, phone: '111222555' },
  destination: { type: 'address', address },
  parcel: { lengthMm: 400, widthMm: 300, heightMm: 150, weightGrams: 2500 },
  cashOnDelivery: null,
}

const body = (request: ShipmentRequest, settings: Parameters<typeof toShipxShipment>[1] = config) => {
  const mapped = toShipxShipment(request, settings)
  if (!mapped.ok) throw new Error(`refused with ${mapped.code}`)
  return mapped.value
}
const refusal = (request: ShipmentRequest) => {
  const mapped = toShipxShipment(request, config)
  return mapped.ok ? null : mapped.code
}

describe('normalizePhone', () => {
  it.each([
    ['111222333', '111222333'],
    ['111 222 333', '111222333'],
    ['111-222-333', '111222333'],
    ['+48111222333', '111222333'],
    ['+48 111 222 333', '111222333'],
    ['(+48) 111-222-333', '111222333'],
    ['0048111222333', '111222333'],
    ['48111222333', '111222333'],
    // Nine digits that happen to start with 48 are a whole number, not a prefix.
    ['481112223', '481112223'],
  ])('reads %s as %s', (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected)
  })

  it.each(['', '11122233', '1112223334', '+49 151 12345678', '+111222333', '0111222333', '00111222333', '49111222333', '111222333 ext. 4', 'brak'])(
    'refuses %s',
    (raw) => {
      expect(normalizePhone(raw)).toBeNull()
    },
  )
})

describe('receiverName', () => {
  it('splits at the last space', () => {
    expect(receiverName('Jan Kowalski', null)).toEqual({ first_name: 'Jan', last_name: 'Kowalski' })
    expect(receiverName('  Maria   Anna Wisniewska ', null)).toEqual({ first_name: 'Maria Anna', last_name: 'Wisniewska' })
  })

  it('sends the company beside the name', () => {
    expect(receiverName('Jan Kowalski', 'Pracownia Przykladowa')).toEqual({ company_name: 'Pracownia Przykladowa', first_name: 'Jan', last_name: 'Kowalski' })
  })

  it('never prints a one-word name twice', () => {
    expect(receiverName('Kowalski', null)).toEqual({ company_name: 'Kowalski' })
    expect(receiverName('Kowalski', 'Pracownia Przykladowa')).toEqual({ company_name: 'Pracownia Przykladowa', last_name: 'Kowalski' })
  })

  it('sends what there is of a blank name', () => {
    expect(receiverName('   ', null)).toEqual({})
    expect(receiverName('   ', ' Pracownia ')).toEqual({ company_name: 'Pracownia' })
  })
})

describe('receiverAddress', () => {
  it('sends the street line whole, as line1', () => {
    expect(receiverAddress(address)).toEqual({ ok: true, value: { line1: 'ul. Przykladowa 12/4', city: 'Warszawa', post_code: '02-677', country_code: 'PL' } })
  })

  it('takes only Poland', () => {
    expect(receiverAddress({ ...address, countryCode: 'DE' })).toEqual({ ok: false, code: 'destination_country_unsupported' })
  })

  it.each([
    ['02-677', '02-677'],
    ['02677', '02-677'],
    ['02 677', '02-677'],
    [' 02-677 ', '02-677'],
    // Not a Polish post code: left for ShipX to refuse.
    ['2677', '2677'],
    ['SW1A 1AA', 'SW1A 1AA'],
  ])('writes the post code %s as %s', (raw, expected) => {
    expect(formatPostCode(raw)).toBe(expected)
  })
})

describe('plnAmount', () => {
  it.each([
    ['12.50', '12.50'],
    ['0.10', '0.10'],
    ['1999.99', '1999.99'],
    ['1', '1'],
    ['129.9', '129.9'],
    ['0.01', '0.01'],
    ['999999999999999.99', '999999999999999.99'],
    // Zeros that say nothing: a JSON number may not start with one, and a third decimal that is 0 is no grosz.
    ['007.50', '7.50'],
    ['000.5', '0.5'],
    ['12.5000', '12.50'],
  ])('keeps the digits of %s', (amount, expected) => {
    expect(plnAmount(amount)).toBe(expected)
    // The same number, and valid JSON as it stands.
    expect(JSON.parse(expected)).toBe(Number(amount))
  })

  it.each(['12.505', '0.001', '12.5001', '', '12,50', '-1', '1e3', '.5'])('refuses %s', (amount) => {
    expect(plnAmount(amount)).toBeNull()
  })
})

describe('gramsToKilograms', () => {
  it.each([
    [1, '0.001'],
    [10, '0.01'],
    [100, '0.1'],
    [500, '0.5'],
    [999, '0.999'],
    [1000, '1'],
    [1250, '1.25'],
    [2500, '2.5'],
    [12345, '12.345'],
    [25000, '25'],
    [50000, '50'],
    // 0.1 + 0.2 territory for a float; digits moved in a string stay exact.
    [300, '0.3'],
    [1001, '1.001'],
  ])('writes %i g as %s kg', (grams, expected) => {
    expect(gramsToKilograms(grams)).toBe(expected)
  })
})

describe('isNonStandard', () => {
  it('follows the size rule: a side above 120 cm, or the sides above 220 cm together', () => {
    expect(isNonStandard({ lengthMm: 1200, widthMm: 500, heightMm: 500 })).toBe(false)
    expect(isNonStandard({ lengthMm: 1201, widthMm: 100, heightMm: 100 })).toBe(true)
    expect(isNonStandard({ lengthMm: 800, widthMm: 800, heightMm: 600 })).toBe(false)
    expect(isNonStandard({ lengthMm: 800, widthMm: 800, heightMm: 601 })).toBe(true)
  })
})

describe('toShipxShipment', () => {
  it('maps a locker Shipment', () => {
    expect(body(lockerRequest)).toStrictEqual({
      receiver: { first_name: 'Jan', last_name: 'Kowalski', email: 'jan.kowalski@example.com', phone: '111222333' },
      parcels: { template: 'small' },
      custom_attributes: { sending_method: 'any_point', target_point: 'KRA010' },
      service: 'inpost_locker_standard',
      reference: 'shp_locker_1',
    })
  })

  it('maps a courier Shipment: one parcel with an id, in mm and kg', () => {
    expect(body(courierRequest)).toStrictEqual({
      receiver: {
        company_name: 'Pracownia Przykladowa',
        first_name: 'Maria Anna',
        last_name: 'Wisniewska',
        phone: '111222555',
        address: { line1: 'ul. Przykladowa 12/4', city: 'Warszawa', post_code: '02-677', country_code: 'PL' },
      },
      parcels: [{ id: '1', dimensions: { length: '400', width: '300', height: '150', unit: 'mm' }, weight: { amount: '2.5', unit: 'kg' }, is_non_standard: false }],
      custom_attributes: { sending_method: 'dispatch_order' },
      service: 'inpost_courier_standard',
      reference: 'shp_courier_1',
    })
  })

  it('takes the sending method from the setting of the service kind', () => {
    const settings = { lockerSendingMethod: 'pop', courierSendingMethod: 'branch' } as const
    expect(body(lockerRequest, settings).custom_attributes).toEqual({ sending_method: 'pop', target_point: 'KRA010' })
    expect(body(courierRequest, settings).custom_attributes).toEqual({ sending_method: 'branch' })
  })

  it('never names a sender: ShipX uses the organization', () => {
    expect(body(lockerRequest)).not.toHaveProperty('sender')
    expect(body(courierRequest)).not.toHaveProperty('sender')
  })

  it('puts the reference last, so it is the key a repeat is found by and nothing after it', () => {
    expect(Object.keys(body(lockerRequest)).at(-1)).toBe('reference')
    expect(Object.keys(body({ ...courierRequest, cashOnDelivery: { amount: '10.00', currency: 'PLN' } })).at(-1)).toBe('reference')
  })

  it('sends cash on delivery for a locker without insurance', () => {
    const mapped = body({ ...lockerRequest, cashOnDelivery: { amount: '12.50', currency: 'PLN' } })
    expect(mapped.cod).toEqual({ amount: '12.50', currency: 'PLN' })
    expect(mapped).not.toHaveProperty('insurance')
  })

  it('insures a courier parcel for its cash on delivery', () => {
    const mapped = body({ ...courierRequest, cashOnDelivery: { amount: '1999.99', currency: 'PLN' } })
    expect(mapped.cod).toEqual({ amount: '1999.99', currency: 'PLN' })
    expect(mapped.insurance).toEqual({ amount: '1999.99', currency: 'PLN' })
  })

  it('marks a courier parcel above the standard size', () => {
    const mapped = body({ ...courierRequest, parcel: { lengthMm: 1500, widthMm: 300, heightMm: 300, weightGrams: 12000 } })
    expect(mapped.parcels).toMatchObject([{ weight: { amount: '12', unit: 'kg' }, is_non_standard: true }])
  })

  it.each([
    ['a missing phone', { ...lockerRequest, receiver: { ...lockerRequest.receiver, phone: null } }, 'receiver_phone_missing'],
    ['a foreign phone', { ...lockerRequest, receiver: { ...lockerRequest.receiver, phone: '+49 151 12345678' } }, 'receiver_phone_invalid'],
    ['a locker Shipment without an e-mail', { ...lockerRequest, receiver: { ...lockerRequest.receiver, email: null } }, 'receiver_email_missing'],
    ['a locker Shipment with a blank e-mail', { ...lockerRequest, receiver: { ...lockerRequest.receiver, email: '  ' } }, 'receiver_email_missing'],
    ['a courier Shipment without a phone', { ...courierRequest, receiver: { ...courierRequest.receiver, phone: null } }, 'receiver_phone_missing'],
    ['an address abroad', { ...courierRequest, destination: { type: 'address', address: { ...address, countryCode: 'DE' } } }, 'destination_country_unsupported'],
    ['cash on delivery in euro', { ...lockerRequest, cashOnDelivery: { amount: '12.50', currency: 'EUR' } }, 'cod_currency_unsupported'],
    ['cash on delivery with a fraction of a grosz', { ...lockerRequest, cashOnDelivery: { amount: '12.505', currency: 'PLN' } }, 'cod_amount_invalid'],
    ['a reference ShipX would refuse as too short', { ...lockerRequest, reference: 'ab' }, 'reference_unsupported'],
    ['a reference ShipX would cut', { ...lockerRequest, reference: 'r'.repeat(101) }, 'reference_unsupported'],
    ['a reference ShipX could trim', { ...lockerRequest, reference: ' shp_1 ' }, 'reference_unsupported'],
    ['a service this connector does not offer', { ...lockerRequest, service: 'inpost_locker_allegro' }, 'service_unsupported'],
    ['a locker Shipment to an address', { ...lockerRequest, destination: courierRequest.destination }, 'destination_unsupported'],
    ['a locker Shipment with dimensions', { ...lockerRequest, parcel: courierRequest.parcel }, 'parcel_unsupported'],
    ['a courier Shipment to a pickup point', { ...courierRequest, destination: lockerRequest.destination }, 'destination_unsupported'],
    ['a courier Shipment with a preset', { ...courierRequest, parcel: lockerRequest.parcel }, 'parcel_unsupported'],
  ] as Array<[string, ShipmentRequest, string]>)('refuses %s', (_what, request, code) => {
    expect(refusal(request)).toBe(code)
  })

  it('does not ask a courier Shipment for an e-mail', () => {
    expect(refusal({ ...courierRequest, receiver: { ...courierRequest.receiver, email: null } })).toBeNull()
    expect(body({ ...courierRequest, receiver: { ...courierRequest.receiver, email: 'maria@example.com' } }).receiver.email).toBe('maria@example.com')
  })
})

describe('shipmentJson', () => {
  const withCod = (amount: string) => shipmentJson(body({ ...courierRequest, cashOnDelivery: { amount, currency: 'PLN' } }))

  it.each(['12.50', '0.10', '1999.99', '129.90', '1.00', '100'])('writes %s as a number with the same digits', (amount) => {
    const json = withCod(amount)
    expect(json).toContain(`"insurance":{"amount":${amount},"currency":"PLN"},"cod":{"amount":${amount},"currency":"PLN"}`)
    const parsed = JSON.parse(json) as { cod: { amount: unknown } }
    expect(typeof parsed.cod.amount).toBe('number')
  })

  it('writes a body without amounts as plain JSON, keys in ShipX order', () => {
    expect(shipmentJson(body(lockerRequest))).toBe(
      '{"receiver":{"first_name":"Jan","last_name":"Kowalski","email":"jan.kowalski@example.com","phone":"111222333"},"parcels":{"template":"small"},' +
        '"custom_attributes":{"sending_method":"any_point","target_point":"KRA010"},"service":"inpost_locker_standard","reference":"shp_locker_1"}',
    )
  })

  it('writes dimensions and weight as the strings the documentation shows', () => {
    expect(shipmentJson(body(courierRequest))).toContain('"dimensions":{"length":"400","width":"300","height":"150","unit":"mm"},"weight":{"amount":"2.5","unit":"kg"}')
  })
})

describe('rejectionCode', () => {
  it.each([
    [{ target_point: ['does_not_exist'] }, 'target_point.does_not_exist'],
    [{ name: ['required', 'too_short'], post_code: ['invalid_format'] }, 'name.required'],
    [{ receiver: { phone: ['invalid'] } }, 'receiver.phone.invalid'],
    [{ 'receiver.phone': ['invalid'] }, 'receiver.phone.invalid'],
    [{ receiver: [{ address: [{ post_code: ['invalid_format'] }] }] }, 'receiver.0.address.0.post_code.invalid_format'],
    [{ parcels: [null, { weight: { amount: ['too_small'] } }] }, 'parcels.1.weight.amount.too_small'],
    [{ custom_attributes: { target_point: 'invalid_box_machine_function' } }, 'custom_attributes.target_point.invalid_box_machine_function'],
  ])('reads %j as %s', (details, expected) => {
    expect(rejectionCode(details)).toBe(expected)
  })

  it.each([
    // A message where a key belongs: the field is kept, the sentence is not.
    [{ target_point: ['Point KRA010 does not exist'] }, 'target_point'],
    // Something that could be a phone or a post code is not a key.
    [{ phone: ['111222333'] }, 'phone'],
    [{ post_code: ['02-677'] }, 'post_code'],
    [{ 'Jan Kowalski': ['invalid'] }, 'validation_failed'],
    [{ 'parcels[0]': ['invalid'] }, 'validation_failed'],
    [{}, 'validation_failed'],
    [null, 'validation_failed'],
    [undefined, 'validation_failed'],
    ['Insurance should be equal or higher than COD', 'validation_failed'],
    [[], 'validation_failed'],
  ])('never builds a code from text: %j is %s', (details, expected) => {
    expect(rejectionCode(details)).toBe(expected)
  })

  it('always fits the code pattern of the SDK', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: { l: ['required'] } } } } } } } } } } } }
    const long = { ['f'.repeat(50)]: { ['g'.repeat(50)]: { ['h'.repeat(50)]: ['required'] } } }
    for (const details of [deep, long]) expect(rejectionCode(details)).toMatch(/^[A-Za-z0-9_.:-]{1,100}$/)
  })
})

describe('createRefusalCode', () => {
  it('builds the code of a validation error from its details', () => {
    expect(createRefusalCode({ error: 'validation_failed', details: { target_point: ['does_not_exist'] } })).toBe('target_point.does_not_exist')
    expect(createRefusalCode({ error: 'validation_failed' })).toBe('validation_failed')
  })

  it.each(['no_carriers', 'carrier_unavailable', 'offer_expired'])('takes %s as a refusal of this request', (key) => {
    expect(createRefusalCode({ error: key, details: {} })).toBe(key)
  })

  it.each(['debt_collection', 'trucker_ID_is_not_set_for_organization'])('leaves %s, which is about the account, to fail the call', (key) => {
    expect(createRefusalCode({ error: key })).toBeNull()
  })

  it('does not take a sentence for a key', () => {
    expect(createRefusalCode({ error: 'Insurance should be equal or higher than COD' })).toBeNull()
    expect(createRefusalCode({ error: '' })).toBeNull()
  })
})

const shipment = (overrides: Partial<ShipxShipment>): ShipxShipment => ({
  id: '1600000101',
  status: 'created',
  tracking_number: null,
  service: 'inpost_locker_standard',
  reference: 'shp_locker_1',
  offers: [],
  transactions: [],
  ...overrides,
})

const offer = (status: string, service: string, reasons?: string[]) => ({
  status,
  service: { id: service },
  unavailability_reasons: reasons?.map((key) => ({ key })) ?? null,
})

describe('purchaseFailure', () => {
  it('is null while the purchase is under way', () => {
    expect(purchaseFailure(shipment({}))).toBeNull()
    expect(purchaseFailure(shipment({ status: 'offers_prepared', offers: [offer('available', 'inpost_locker_standard')] }))).toBeNull()
    expect(purchaseFailure(shipment({ status: 'offer_selected', offers: [offer('selected', 'inpost_locker_standard')], transactions: [{ status: 'initiated' }] }))).toBeNull()
    expect(purchaseFailure(shipment({ status: 'offers_prepared', offers: null, transactions: undefined }))).toBeNull()
  })

  it('names the reason of an unavailable offer', () => {
    const offers = [offer('unavailable', 'inpost_locker_standard', ['parcels_size_invalid', 'sending_method_required'])]
    expect(purchaseFailure(shipment({ status: 'offers_prepared', offers }))).toBe('parcels_size_invalid')
    expect(purchaseFailure(shipment({ status: 'created', offers }))).toBe('parcels_size_invalid')
  })

  it('has a code of its own when the offer gives no readable reason', () => {
    expect(purchaseFailure(shipment({ status: 'offers_prepared', offers: [offer('unavailable', 'inpost_locker_standard')] }))).toBe('offer_unavailable')
    expect(purchaseFailure(shipment({ status: 'offers_prepared', offers: [offer('unavailable', 'inpost_locker_standard', ['Parcel is too large or too heavy.'])] }))).toBe(
      'offer_unavailable',
    )
  })

  it('looks at the offers of the service that was asked for', () => {
    const offers = [offer('unavailable', 'inpost_courier_standard', ['parcels_size_invalid']), offer('available', 'inpost_locker_standard')]
    expect(purchaseFailure(shipment({ status: 'offers_prepared', offers }))).toBeNull()
    expect(purchaseFailure(shipment({ status: 'offers_prepared', service: 'inpost_courier_standard', offers }))).toBe('parcels_size_invalid')
  })

  it('does not call one unavailable offer a failure while another can be bought', () => {
    const offers = [offer('unavailable', 'inpost_locker_economy', ['parcels_size_invalid']), offer('available', 'inpost_locker_customer_service_point')]
    expect(purchaseFailure(shipment({ status: 'offers_prepared', offers }))).toBeNull()
  })

  it('names a failed payment', () => {
    expect(purchaseFailure(shipment({ status: 'offer_selected', offers: [offer('selected', 'inpost_locker_standard')], transactions: [{ status: 'failure' }] }))).toBe('transaction_failure')
    expect(purchaseFailure(shipment({ status: 'offer_selected', transactions: [{ status: 'failure' }, { status: 'success' }] }))).toBeNull()
  })

  it('applies only before the purchase: a bought shipment is past it', () => {
    expect(purchaseFailure(shipment({ status: 'confirmed', offers: [offer('unavailable', 'inpost_locker_standard')], transactions: [{ status: 'failure' }] }))).toBeNull()
  })
})

describe('toShipmentState', () => {
  it('maps a new shipment', () => {
    expect(toShipmentState(shipment({}))).toEqual({ externalId: '1600000101', status: 'pending', trackingNumber: null, carrierStatus: 'created' })
  })

  it('maps a bought shipment, with its tracking number', () => {
    expect(toShipmentState(shipment({ status: 'confirmed', tracking_number: '620999548227330124560017' }))).toEqual({
      externalId: '1600000101',
      status: 'ready',
      trackingNumber: '620999548227330124560017',
      carrierStatus: 'confirmed',
    })
  })

  it('reports a purchase that will not happen as failed, with the reason', () => {
    expect(toShipmentState(shipment({ status: 'offers_prepared', offers: [offer('unavailable', 'inpost_locker_standard', ['parcels_size_invalid'])] }))).toEqual({
      externalId: '1600000101',
      status: 'failed',
      trackingNumber: null,
      carrierStatus: 'parcels_size_invalid',
    })
  })

  it('has no tracking number for an empty one', () => {
    expect(toShipmentState(shipment({ tracking_number: '' }))?.trackingNumber).toBeNull()
  })

  it.each(['sorted_by_drone', 'other', 'constructor', 'toString', '__proto__', ''])('does not guess at the status "%s"', (status) => {
    expect(toShipmentState(shipment({ status }))).toBeNull()
  })

  it('fails as permanent when a shipment cannot be a Shipment state', () => {
    expect(() => toShipmentState(shipment({ id: '' }))).toThrow(PermanentError)
  })
})
