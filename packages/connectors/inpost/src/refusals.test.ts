import { describe, expect, it } from 'vitest'
import { createRefusal, rejectionCode } from './refusals'

describe('rejectionCode', () => {
  it.each([
    // What the sandbox answered for a locker that does not exist (2026-10-10), and the flat shape of the FAQ.
    [{ custom_attributes: [{ target_point: ['does_not_exist'] }] }, 'target_point.does_not_exist'],
    [{ target_point: ['does_not_exist'] }, 'target_point.does_not_exist'],
    [{ custom_attributes: { target_point: 'invalid_box_machine_function' } }, 'target_point.invalid_box_machine_function'],
    [{ custom_attributes: [{ sending_method: ['invalid'] }] }, 'sending_method.invalid'],
    [{ receiver: { phone: ['invalid'] } }, 'receiver.phone.invalid'],
    [{ 'receiver.phone': ['invalid_format'] }, 'receiver.phone.invalid_format'],
    [{ receiver: [{ address: [{ post_code: ['invalid_format'] }] }] }, 'receiver.address.post_code.invalid_format'],
    [{ parcels: [null, { weight: { amount: ['too_small'] } }] }, 'parcels.weight.amount.too_small'],
    [{ cod: { amount: ['not_a_number'] } }, 'cod.amount.not_a_number'],
    [{ insurance: [{ amount: ['too_small', 'not_an_integer'] }] }, 'insurance.amount.too_small'],
    [{ reference: ['too_long'] }, 'reference.too_long'],
    [{ service: ['required'] }, 'service.required'],
  ])('reads %j as %s', (details, expected) => {
    expect(rejectionCode(details)).toBe(expected)
  })

  it('takes the first field of the request that has a key it knows', () => {
    // The documentation's own example: `name` is no field this connector sends.
    expect(rejectionCode({ name: ['required', 'too_short'], post_code: ['invalid_format'] })).toBe('post_code.invalid_format')
    expect(rejectionCode({ receiver: { email: ['Not an e-mail address'], phone: ['invalid'] } })).toBe('receiver.phone.invalid')
    expect(rejectionCode({ phone: ['is_not_polish', 'too_short'] })).toBe('phone.too_short')
  })

  it.each([
    // A value where a key belongs: a name, a number, a sentence, a key that echoes the input.
    [{ phone: ['Kowalski'] }],
    [{ phone: ['111222333'] }],
    [{ post_code: ['02-677'] }],
    [{ target_point: ['Point KRA010 does not exist'] }],
    [{ target_point: ['kra010_does_not_exist'] }],
    // What ShipX really answers `?id=abc`: the input, inside the key.
    [{ shipment: ['id_abc_does_not_exist'] }],
    // A value where a field belongs.
    [{ '111222333': ['invalid'] }],
    [{ 'Jan Kowalski': ['invalid'] }],
    [{ Kowalski: { phone: ['invalid'] } }],
    [{ receiver: { Kowalski: ['invalid'] } }],
    [{ 'parcels[0]': ['invalid'] }],
    [{ 'receiver.kowalski': ['invalid'] }],
    // A key with no field to hang on.
    [['required']],
    ['required'],
    [{ custom_attributes: ['invalid'] }],
    [{}],
    [null],
    [undefined],
    ['Insurance should be equal or higher than COD'],
    [[]],
    [42],
  ])('never builds a code from the answer itself: %j is validation_failed', (details) => {
    expect(rejectionCode(details)).toBe('validation_failed')
  })

  it('always fits the code pattern of the SDK', () => {
    const deep = { receiver: { address: { receiver: { address: { receiver: { address: { receiver: { address: { receiver: { address: { phone: ['required'] } } } } } } } } } } }
    const long = { receiver: { custom_attributes: { is_non_standard: { is_non_standard: { is_non_standard: { is_non_standard: { is_non_standard: { is_non_standard: ['invalid_box_machine_function'] } } } } } } } }
    for (const details of [deep, long, { receiver: { phone: ['invalid'] } }]) expect(rejectionCode(details)).toMatch(/^[A-Za-z0-9_.:-]{1,100}$/)
    expect(rejectionCode(deep)).toBe('validation_failed')
    expect(rejectionCode(long)).toBe('validation_failed')
  })
})

describe('createRefusal', () => {
  it('rejects a validation error with the code its details give', () => {
    expect(createRefusal({ error: 'validation_failed', details: { custom_attributes: [{ target_point: ['does_not_exist'] }] } })).toEqual({ kind: 'rejected', code: 'target_point.does_not_exist' })
    expect(createRefusal({ error: 'validation_failed' })).toEqual({ kind: 'rejected', code: 'validation_failed' })
    expect(createRefusal({ error: 'validation_failed', details: null })).toEqual({ kind: 'rejected', code: 'validation_failed' })
  })

  it.each([
    ['carrier_unavailable', 'carrier_unavailable'],
    ['missing_trucker_id', 'missing_trucker_id'],
    ['trucker_ID_is_not_set_for_organization', 'missing_trucker_id'],
  ])('rejects %s, which is about the service the request names', (key, code) => {
    expect(createRefusal({ error: key, details: null })).toEqual({ kind: 'rejected', code })
  })

  it.each(['debt_collection', 'no_carriers', 'DEBT_COLLECTION'])('leaves %s, which is about the account, to fail the call', (key) => {
    expect(createRefusal({ error: key })).toEqual({ kind: 'account', key: key.toLowerCase() })
  })

  it.each(['offer_expired', 'quota_exceeded', 'Kowalski', 'Insurance should be equal or higher than COD', '111222333', '', 'constructor', '__proto__'])(
    'has no code for "%s": an unknown key is never stored',
    (key) => {
      expect(createRefusal({ error: key, details: { phone: ['invalid'] } })).toEqual({ kind: 'unknown' })
    },
  )
})
