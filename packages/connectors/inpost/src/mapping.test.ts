import { PermanentError, type Address, type ShipmentRequest } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import type { ShipxShipment } from './api'
import {
  formatPostCode,
  gramsToKilograms,
  isBelowOneZloty,
  isNonStandard,
  lowerBoundState,
  normalizePhone,
  plnAmount,
  purchaseObstacle,
  receiverAddress,
  receiverName,
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

  // Not left to the schema of the request: `1.2.3` once came out as `1.2`.
  it.each(['1.2.3', '1.', '1..2', '12.50.', '1.2e3', ' 12.50', '12.50\n', '0x10', '1_000', '+12.50', 'NaN', 'Infinity'])('refuses the malformed %j', (amount) => {
    expect(plnAmount(amount)).toBeNull()
  })

  it('tells an amount below one zloty, the least InPost collects', () => {
    for (const amount of ['0', '0.99', '0.5', '0.00']) expect(isBelowOneZloty(plnAmount(amount)!)).toBe(true)
    for (const amount of ['1', '1.00', '01.00', '10', '100.5']) expect(isBelowOneZloty(plnAmount(amount)!)).toBe(false)
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

  it('insures a locker parcel for its cash on delivery too', () => {
    const mapped = body({ ...lockerRequest, cashOnDelivery: { amount: '12.50', currency: 'PLN' } })
    expect(mapped.cod).toEqual({ amount: '12.50', currency: 'PLN' })
    expect(mapped.insurance).toEqual({ amount: '12.50', currency: 'PLN' })
    expect(Object.keys(mapped)).toEqual(['receiver', 'parcels', 'insurance', 'cod', 'custom_attributes', 'service', 'reference'])
  })

  it('sends neither without cash on delivery', () => {
    expect(body(lockerRequest)).not.toHaveProperty('insurance')
    expect(body(lockerRequest)).not.toHaveProperty('cod')
    expect(body(courierRequest)).not.toHaveProperty('insurance')
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
    ['cash on delivery that is not a decimal', { ...lockerRequest, cashOnDelivery: { amount: '1.2.3', currency: 'PLN' } }, 'cod_amount_invalid'],
    ['cash on delivery below 1 PLN', { ...lockerRequest, cashOnDelivery: { amount: '0.99', currency: 'PLN' } }, 'cod_amount_too_small'],
    ['cash on delivery of nothing', { ...courierRequest, cashOnDelivery: { amount: '0.00', currency: 'PLN' } }, 'cod_amount_too_small'],
    ['a reference ShipX would refuse as too short', { ...lockerRequest, reference: 'ab' }, 'reference_unsupported'],
    ['a service this connector does not offer', { ...lockerRequest, service: 'inpost_locker_allegro' }, 'service_unsupported'],
    ['a locker Shipment to an address', { ...lockerRequest, destination: courierRequest.destination }, 'destination_unsupported'],
    ['a locker Shipment with dimensions', { ...lockerRequest, parcel: courierRequest.parcel }, 'parcel_unsupported'],
    ['a courier Shipment to a pickup point', { ...courierRequest, destination: lockerRequest.destination }, 'destination_unsupported'],
    ['a courier Shipment with a preset', { ...courierRequest, parcel: lockerRequest.parcel }, 'parcel_unsupported'],
  ] as Array<[string, ShipmentRequest, string]>)('refuses %s', (_what, request, code) => {
    expect(refusal(request)).toBe(code)
  })

  it('takes every reference the SDK lets through that ShipX takes: three characters and up', () => {
    for (const reference of ['abc', 'a-b', '3f2a9c1e-7b54-4d0a-9e6f-2c8b1a5d4e7f', 'r'.repeat(64)]) expect(body({ ...lockerRequest, reference }).reference).toBe(reference)
    for (const reference of ['a', 'ab']) expect(refusal({ ...lockerRequest, reference })).toBe('reference_unsupported')
  })

  it('does not ask a courier Shipment for an e-mail', () => {
    expect(refusal({ ...courierRequest, receiver: { ...courierRequest.receiver, email: null } })).toBeNull()
    expect(body({ ...courierRequest, receiver: { ...courierRequest.receiver, email: 'maria@example.com' } }).receiver.email).toBe('maria@example.com')
  })
})

describe('shipmentJson', () => {
  const withCod = (amount: string) => shipmentJson(body({ ...courierRequest, cashOnDelivery: { amount, currency: 'PLN' } }))

  it.each(['12.50', '1.10', '1999.99', '129.90', '1.00', '100'])('writes %s as a number with the same digits', (amount) => {
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

const failure = (error: unknown) => ({ status: 'failure', details: { error } as { error: string } })

describe('purchaseObstacle', () => {
  it('is null while the purchase is under way', () => {
    expect(purchaseObstacle(shipment({}))).toBeNull()
    expect(purchaseObstacle(shipment({ status: 'offers_prepared', offers: [offer('available', 'inpost_locker_standard')] }))).toBeNull()
    expect(purchaseObstacle(shipment({ status: 'offer_selected', offers: [offer('selected', 'inpost_locker_standard')], transactions: [{ status: 'initiated' }] }))).toBeNull()
    expect(purchaseObstacle(shipment({ status: 'offers_prepared', offers: null, transactions: undefined }))).toBeNull()
  })

  it('is final, with the reason, when the only offer is unavailable', () => {
    const offers = [offer('unavailable', 'inpost_locker_standard', ['parcels_size_invalid', 'sending_method_required'])]
    expect(purchaseObstacle(shipment({ status: 'offers_prepared', offers }))).toEqual({ final: true, key: 'parcels_size_invalid' })
    expect(purchaseObstacle(shipment({ status: 'created', offers }))).toEqual({ final: true, key: 'parcels_size_invalid' })
  })

  it('is final when every offer has expired, or is expired or unavailable', () => {
    expect(purchaseObstacle(shipment({ status: 'offers_prepared', offers: [offer('expired', 'inpost_locker_standard')] }))).toEqual({ final: true, key: 'offer_expired' })
    const mixed = [offer('expired', 'inpost_locker_standard'), offer('unavailable', 'inpost_locker_standard')]
    expect(purchaseObstacle(shipment({ status: 'offers_prepared', offers: mixed }))).toEqual({ final: true, key: 'offer_unavailable' })
  })

  it('has a code of its own when the offer gives no reason that reads as a key', () => {
    expect(purchaseObstacle(shipment({ status: 'offers_prepared', offers: [offer('unavailable', 'inpost_locker_standard')] }))).toEqual({ final: true, key: 'offer_unavailable' })
    for (const reason of ['Parcel is too large or too heavy.', 'point_KRA010_closed', 'phone_111222333_invalid', 'Kowalski']) {
      expect(purchaseObstacle(shipment({ status: 'offers_prepared', offers: [offer('unavailable', 'inpost_locker_standard', [reason])] }))).toEqual({ final: true, key: 'offer_unavailable' })
    }
  })

  it('looks at the offers of the service that was asked for', () => {
    const offers = [offer('unavailable', 'inpost_courier_standard', ['parcels_size_invalid']), offer('available', 'inpost_locker_standard')]
    expect(purchaseObstacle(shipment({ status: 'offers_prepared', offers }))).toBeNull()
    expect(purchaseObstacle(shipment({ status: 'offers_prepared', service: 'inpost_courier_standard', offers }))).toEqual({ final: true, key: 'parcels_size_invalid' })
  })

  it('is not final while one offer can still be bought', () => {
    const offers = [offer('unavailable', 'inpost_locker_economy', ['parcels_size_invalid']), offer('available', 'inpost_locker_customer_service_point')]
    expect(purchaseObstacle(shipment({ status: 'offers_prepared', offers }))).toBeNull()
    // A status of an offer InPost adds is not known to be dead.
    expect(purchaseObstacle(shipment({ status: 'offers_prepared', offers: [offer('on_hold', 'inpost_locker_standard')] }))).toBeNull()
  })

  // The shape the sandbox answered without funds: the offer stays `selected`, so a later payment can buy it.
  it('is not final after a failed payment, and names what the payment failed on', () => {
    const selected = [offer('selected', 'inpost_locker_standard')]
    expect(purchaseObstacle(shipment({ status: 'offer_selected', offers: selected, transactions: [failure('debt_collection')] }))).toEqual({ final: false, key: 'debt_collection' })
    expect(purchaseObstacle(shipment({ status: 'offer_selected', offers: selected, transactions: [failure('company_data_missing')] }))).toEqual({ final: false, key: 'company_data_missing' })
    // No offer listed at all: nothing says the purchase is over.
    expect(purchaseObstacle(shipment({ status: 'created', transactions: [failure('debt_collection')] }))).toEqual({ final: false, key: 'debt_collection' })
  })

  it('names the last failed payment', () => {
    const transactions = [failure('debt_collection'), failure('company_data_missing')]
    expect(purchaseObstacle(shipment({ status: 'offer_selected', offers: [offer('selected', 'inpost_locker_standard')], transactions }))).toEqual({ final: false, key: 'company_data_missing' })
  })

  it.each([undefined, null, '', 'Unpaid invoices of Jan Kowalski', 'Kowalski', 'owner_111222333', 422, { error: 'debt_collection' }])('has a code of its own when the payment error is %j, which is no key', (error) => {
    const transactions = [failure(error)]
    expect(purchaseObstacle(shipment({ status: 'offer_selected', offers: [offer('selected', 'inpost_locker_standard')], transactions }))).toEqual({ final: false, key: 'transaction_failure' })
    expect(purchaseObstacle(shipment({ status: 'offer_selected', transactions: [{ status: 'failure' }] }))).toEqual({ final: false, key: 'transaction_failure' })
  })

  it('is over once a payment went through or is under way', () => {
    expect(purchaseObstacle(shipment({ status: 'offer_selected', transactions: [failure('debt_collection'), { status: 'success' }] }))).toBeNull()
    expect(purchaseObstacle(shipment({ status: 'offer_selected', transactions: [failure('debt_collection'), { status: 'initiated' }] }))).toBeNull()
  })

  it('prefers the dead offer to the failed payment: nothing can be paid for any more', () => {
    const transactions = [failure('debt_collection')]
    expect(purchaseObstacle(shipment({ status: 'offer_selected', offers: [offer('expired', 'inpost_locker_standard')], transactions }))).toEqual({ final: true, key: 'offer_expired' })
  })

  it('applies only before the purchase: a bought shipment is past it', () => {
    expect(purchaseObstacle(shipment({ status: 'confirmed', offers: [offer('unavailable', 'inpost_locker_standard')], transactions: [failure('debt_collection')] }))).toBeNull()
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

  it('reports a purchase that can no longer happen as failed, with the reason', () => {
    expect(toShipmentState(shipment({ status: 'offers_prepared', offers: [offer('unavailable', 'inpost_locker_standard', ['parcels_size_invalid'])] }))).toEqual({
      externalId: '1600000101',
      status: 'failed',
      trackingNumber: null,
      carrierStatus: 'parcels_size_invalid',
    })
  })

  it('keeps a Shipment whose payment failed pending, and says what it waits for', () => {
    expect(toShipmentState(shipment({ status: 'offer_selected', offers: [offer('selected', 'inpost_locker_standard')], transactions: [failure('debt_collection')] }))).toEqual({
      externalId: '1600000101',
      status: 'pending',
      trackingNumber: null,
      carrierStatus: 'debt_collection',
    })
  })

  it('has no tracking number for an empty one', () => {
    expect(toShipmentState(shipment({ tracking_number: '' }))?.trackingNumber).toBeNull()
  })

  it.each(['sorted_by_drone', 'other', 'missing', 'constructor', 'toString', '__proto__', ''])('does not guess at the status "%s"', (status) => {
    expect(toShipmentState(shipment({ status }))).toBeNull()
  })

  it('fails as permanent when a shipment cannot be a Shipment state', () => {
    expect(() => toShipmentState(shipment({ id: '' }))).toThrow(PermanentError)
  })
})

describe('lowerBoundState', () => {
  it('says InPost has the request, and no more, without a tracking number', () => {
    expect(lowerBoundState(shipment({ status: 'sorted_by_drone' }))).toEqual({ externalId: '1600000101', status: 'pending', trackingNumber: null, carrierStatus: 'sorted_by_drone' })
    expect(lowerBoundState(shipment({ status: 'other', tracking_number: '' }))).toMatchObject({ status: 'pending', trackingNumber: null, carrierStatus: 'other' })
  })

  it('says the label is bought with a tracking number', () => {
    expect(lowerBoundState(shipment({ status: 'sorted_by_drone', tracking_number: '620999548227330124560017' }))).toEqual({
      externalId: '1600000101',
      status: 'ready',
      trackingNumber: '620999548227330124560017',
      carrierStatus: 'sorted_by_drone',
    })
  })

  // Whatever the name suggests: a status that says the Carrier has the parcel ships the Order.
  it.each(['delivered_by_drone', 'out_for_delivery_by_robot', 'returned_to_sender_again', 'other', 'missing'])('never reports "%s" as handed over', (status) => {
    expect(['pending', 'ready']).toContain(lowerBoundState(shipment({ status })).status)
    expect(['pending', 'ready']).toContain(lowerBoundState(shipment({ status, tracking_number: '620999548227330124560017' })).status)
  })

  it.each(['Sorted by a drone', 'jan.kowalski@example.com', '02-677', 'Zażółć', ''])('carries no carrier status for "%s", which is no key', (status) => {
    expect(lowerBoundState(shipment({ status })).carrierStatus).toBeNull()
  })
})
