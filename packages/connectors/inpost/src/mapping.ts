import { PermanentError, shipmentStateSchema, type Address, type ShipmentRequest, type ShipmentState } from '@hanza/connector-sdk'
import type { ShipxShipment } from './api'
import { COURIER_SERVICE, LOCKER_SERVICE, type InpostConfig } from './config'
import { INPOST_STATUSES, PURCHASE_STATUSES } from './statuses'

/** A request ShipX can take, or the code this connector refuses it with before asking. */
export type Mapped<T> = { ok: true; value: T } | { ok: false; code: string }

const refuse = (code: string): { ok: false; code: string } => ({ ok: false, code })

/** `amount` is still a decimal string here; `shipmentJson` writes it as a JSON number, digit for digit. */
export interface ShipxMoney {
  amount: string
  currency: 'PLN'
}

export interface ShipxReceiver {
  company_name?: string
  first_name?: string
  last_name?: string
  email?: string
  phone: string
  address?: { line1: string; city: string; post_code: string; country_code: 'PL' }
}

export interface ShipxParcel {
  id: string
  dimensions: { length: string; width: string; height: string; unit: 'mm' }
  weight: { amount: string; unit: 'kg' }
  is_non_standard: boolean
}

/** The body of `POST /v1/organizations/{id}/shipments` in simplified mode; `sender` is left to the organization's data. */
export interface ShipxShipmentBody {
  receiver: ShipxReceiver
  parcels: { template: string } | ShipxParcel[]
  insurance?: ShipxMoney
  cod?: ShipxMoney
  custom_attributes: { sending_method: string; target_point?: string }
  service: string
  reference: string
}

/** A Polish number as ShipX takes it: 9 digits, no prefix. Null for anything else. */
export function normalizePhone(raw: string): string | null {
  const compact = raw.replace(/[\s()-]/g, '')
  const digits = compact.replace(/^(\+|00)(?=48\d{9}$)/, '')
  if (/^\d{9}$/.test(digits)) return digits
  return /^48\d{9}$/.test(digits) ? digits.slice(2) : null
}

/**
 * The canonical name is one string; ShipX wants a company name and/or a first and a last name. Split at the last
 * space. A one-word name cannot be split: next to a company it is the last name, alone it goes as the company name,
 * so the rule holds without printing the word twice.
 */
export function receiverName(name: string, company: string | null): Pick<ShipxReceiver, 'company_name' | 'first_name' | 'last_name'> {
  const words = name.trim().split(/\s+/).filter((word) => word !== '')
  const companyName = company?.trim() || null
  if (words.length >= 2) {
    return { ...(companyName ? { company_name: companyName } : {}), first_name: words.slice(0, -1).join(' '), last_name: words.at(-1)! }
  }
  const [word] = words
  if (word === undefined) return companyName ? { company_name: companyName } : {}
  return companyName ? { company_name: companyName, last_name: word } : { company_name: word }
}

/** `02677` and `02 677` as `02-677`; anything else unchanged, for ShipX to judge. */
export function formatPostCode(postalCode: string): string {
  const match = /^(\d{2})-?(\d{3})$/.exec(postalCode.replace(/\s/g, ''))
  return match ? `${match[1]}-${match[2]}` : postalCode
}

/**
 * The canonical street line holds street, building and flat. It goes whole into `line1`, which ShipX still takes:
 * splitting it into `street` and `building_number` would mean guessing where a Polish address ends its street name.
 */
export function receiverAddress(address: Address): Mapped<NonNullable<ShipxReceiver['address']>> {
  if (address.countryCode !== 'PL') return refuse('destination_country_unsupported')
  return { ok: true, value: { line1: address.street, city: address.city, post_code: formatPostCode(address.postalCode), country_code: 'PL' } }
}

/**
 * A PLN amount as the text of a JSON number with the same digits (`"12.50"` stays `12.50`). Null when it has a
 * fraction of a grosz, which ShipX could only round. String operations only: the amount never becomes a float.
 */
export function plnAmount(amount: string): string | null {
  const [whole = '', fraction = ''] = amount.split('.')
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction) || /[1-9]/.test(fraction.slice(2))) return null
  const integer = whole.replace(/^0+(?=\d)/, '')
  return fraction === '' ? integer : `${integer}.${fraction.slice(0, 2)}`
}

/** Grams as kilograms, exactly (`1250` is `"1.25"`), by moving the decimal point in the digits. */
export function gramsToKilograms(grams: number): string {
  const digits = String(grams).padStart(4, '0')
  const fraction = digits.slice(-3).replace(/0+$/, '')
  return fraction === '' ? digits.slice(0, -3) : `${digits.slice(0, -3)}.${fraction}`
}

/** InPost's size rule for a non-standard courier parcel: one side above 120 cm, or the three sides above 220 cm together. */
export function isNonStandard(parcel: { lengthMm: number; widthMm: number; heightMm: number }): boolean {
  const sides = [parcel.lengthMm, parcel.widthMm, parcel.heightMm]
  return sides.some((side) => side > 1200) || sides.reduce((sum, side) => sum + side, 0) > 2200
}

function receiverOf(request: ShipmentRequest): Mapped<ShipxReceiver> {
  const { receiver } = request
  if (receiver.phone === null) return refuse('receiver_phone_missing')
  const phone = normalizePhone(receiver.phone)
  if (phone === null) return refuse('receiver_phone_invalid')
  const email = receiver.email?.trim() || null
  // The locker tells the Buyer by e-mail and text message that the parcel waits.
  if (request.service === LOCKER_SERVICE && email === null) return refuse('receiver_email_missing')
  return { ok: true, value: { ...receiverName(receiver.name, receiver.company), ...(email ? { email } : {}), phone } }
}

function cashOnDeliveryOf(request: ShipmentRequest): Mapped<ShipxMoney | null> {
  const { cashOnDelivery } = request
  if (cashOnDelivery === null) return { ok: true, value: null }
  if (cashOnDelivery.currency !== 'PLN') return refuse('cod_currency_unsupported')
  const amount = plnAmount(cashOnDelivery.amount)
  return amount === null ? refuse('cod_amount_invalid') : { ok: true, value: { amount, currency: 'PLN' } }
}

/**
 * A Shipment request as a ShipX shipment, or the code it is refused with before any request is made. `reference`
 * is last on purpose: it is the key a repeated create is found by, and it must come back exactly as it was sent.
 */
export function toShipxShipment(request: ShipmentRequest, config: Pick<InpostConfig, 'lockerSendingMethod' | 'courierSendingMethod'>): Mapped<ShipxShipmentBody> {
  const { reference, destination, parcel } = request
  // ShipX takes 3 to 100 characters; one it would trim or cut could never be found again.
  if (reference.length < 3 || reference.length > 100 || reference !== reference.trim()) return refuse('reference_unsupported')
  if (request.service !== LOCKER_SERVICE && request.service !== COURIER_SERVICE) return refuse('service_unsupported')

  const receiver = receiverOf(request)
  if (!receiver.ok) return receiver
  const cod = cashOnDeliveryOf(request)
  if (!cod.ok) return cod

  if (request.service === LOCKER_SERVICE) {
    if (destination.type !== 'pickup_point') return refuse('destination_unsupported')
    if (!('preset' in parcel)) return refuse('parcel_unsupported')
    return {
      ok: true,
      value: {
        receiver: receiver.value,
        parcels: { template: parcel.preset },
        ...(cod.value ? { cod: cod.value } : {}),
        custom_attributes: { sending_method: config.lockerSendingMethod, target_point: destination.pointId },
        service: request.service,
        reference,
      },
    }
  }

  if (destination.type !== 'address') return refuse('destination_unsupported')
  if ('preset' in parcel) return refuse('parcel_unsupported')
  const address = receiverAddress(destination.address)
  if (!address.ok) return address
  return {
    ok: true,
    value: {
      receiver: { ...receiver.value, address: address.value },
      parcels: [
        {
          id: '1',
          dimensions: { length: String(parcel.lengthMm), width: String(parcel.widthMm), height: String(parcel.heightMm), unit: 'mm' },
          weight: { amount: gramsToKilograms(parcel.weightGrams), unit: 'kg' },
          is_non_standard: isNonStandard(parcel),
        },
      ],
      // A courier parcel with cash on delivery must be insured for at least that amount.
      ...(cod.value ? { insurance: cod.value, cod: cod.value } : {}),
      custom_attributes: { sending_method: config.courierSendingMethod },
      service: request.service,
      reference,
    },
  }
}

const rawJson = (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON

/** The request body as JSON text. Amounts become number tokens built from their digits, never from a float. */
export function shipmentJson(body: ShipxShipmentBody): string {
  const money = (value: ShipxMoney | undefined) => value && { amount: rawJson(value.amount), currency: value.currency }
  return JSON.stringify({ ...body, insurance: money(body.insurance), cod: money(body.cod) })
}

// Field names (possibly a dotted path) and error keys are snake_case words. Anything else in their place (a sentence,
// a number that could be a phone or a post code) is not a key and never reaches a code.
const FIELD = /^[A-Za-z0-9_.]{1,80}$/
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,59}$/
const MAX_CODE_LENGTH = 100

export function isKey(value: unknown): value is string {
  return typeof value === 'string' && KEY.test(value)
}

/**
 * The code of a `validation_failed` answer: the first field path in `details` and its first error key, such as
 * `target_point.does_not_exist` or `receiver.phone.invalid`. Built from field names and keys only, never the message.
 */
export function rejectionCode(details: unknown): string {
  const segments: string[] = []
  let node = details
  for (let depth = 0; depth < 10; depth++) {
    if (Array.isArray(node)) {
      const key = node.find((item) => typeof item === 'string')
      if (key !== undefined) {
        if (isKey(key)) segments.push(key)
        break
      }
      const index = node.findIndex((item) => typeof item === 'object' && item !== null)
      if (index === -1) break
      segments.push(String(index))
      node = node[index]
    } else if (typeof node === 'object' && node !== null) {
      const entry = Object.entries(node)[0]
      if (entry === undefined || !FIELD.test(entry[0])) break
      segments.push(entry[0])
      node = entry[1]
    } else {
      if (isKey(node)) segments.push(node)
      break
    }
  }
  const code = segments.join('.').slice(0, MAX_CODE_LENGTH)
  return code === '' ? 'validation_failed' : code
}

// Refusals that are about the account, not about one request: every Shipment would get the same answer.
const ACCOUNT_ERRORS: readonly string[] = ['debt_collection', 'trucker_id_is_not_set_for_organization']

/** The account refusal an error key names, as this connector spells it; null for any other key. */
export function accountRefusal(key: string): string | null {
  return ACCOUNT_ERRORS.find((known) => known === key.toLowerCase()) ?? null
}

/**
 * The code a refused create is `rejected` with, from the error key of the answer; null when the answer is not a
 * refusal of this one request (an account that is blocked, a body that is no ShipX error), which the call fails for.
 */
export function createRefusalCode(error: { error: string; details?: unknown }): string | null {
  if (error.error === 'validation_failed') return rejectionCode(error.details)
  if (!isKey(error.error) || accountRefusal(error.error) !== null) return null
  return error.error
}

/**
 * Why InPost will never buy this shipment, or null. A failed purchase has no status of its own: the shipment stays
 * in a purchase status with every offer for its service unavailable, or with a failed payment transaction.
 */
export function purchaseFailure(shipment: ShipxShipment): string | null {
  if (!PURCHASE_STATUSES.includes(shipment.status)) return null
  const offers = shipment.offers ?? []
  const own = offers.filter((offer) => offer.service?.id === shipment.service)
  // `failed` is final, so one unavailable offer is not enough while another could still be bought.
  const candidates = own.length > 0 ? own : offers
  if (candidates.length > 0 && candidates.every((offer) => offer.status === 'unavailable')) {
    const reason = candidates.flatMap((offer) => offer.unavailability_reasons ?? []).find((item) => isKey(item.key))
    return reason?.key ?? 'offer_unavailable'
  }
  const transactions = shipment.transactions ?? []
  const settled = transactions.some((transaction) => transaction.status === 'success' || transaction.status === 'initiated')
  return transactions.some((transaction) => transaction.status === 'failure') && !settled ? 'transaction_failure' : null
}

/** True for a status name the table has, whatever it translates to. */
export function isKnownStatus(status: string): boolean {
  return Object.hasOwn(INPOST_STATUSES, status)
}

/**
 * A ShipX shipment as a Shipment state. Null when its status says nothing this connector can translate (a name
 * InPost added, or `other`): the caller leaves the Shipment as it is instead of guessing.
 */
export function toShipmentState(shipment: ShipxShipment): ShipmentState | null {
  const translated = isKnownStatus(shipment.status) ? INPOST_STATUSES[shipment.status] : null
  if (translated == null) return null
  const failure = purchaseFailure(shipment)
  const state = shipmentStateSchema.safeParse({
    externalId: shipment.id,
    status: failure === null ? translated : 'failed',
    trackingNumber: shipment.tracking_number || null,
    carrierStatus: failure ?? shipment.status,
  })
  // Paths only: the resource this came from holds the receiver's data.
  if (!state.success) throw new PermanentError(`An InPost shipment does not fit the canonical model: ${state.error.issues.map((issue) => issue.path.join('.')).join(', ')}`, { cause: state.error })
  return state.data
}
