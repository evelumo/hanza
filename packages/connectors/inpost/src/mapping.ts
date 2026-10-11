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
 * A PLN amount as the text of a JSON number with the same digits (`"12.50"` stays `12.50`). Null when it is not a
 * plain decimal (`1.2.3`, `.5`, `1e3`: checked here, not left to the caller's schema) or has a fraction of a grosz,
 * which ShipX could only round. String operations only: the amount never becomes a float.
 */
export function plnAmount(amount: string): string | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount)
  if (!match) return null
  const [, whole = '', fraction = ''] = match
  if (/[1-9]/.test(fraction.slice(2))) return null
  const integer = whole.replace(/^0+(?=\d)/, '')
  return fraction === '' ? integer : `${integer}.${fraction.slice(0, 2)}`
}

/** True for an amount `plnAmount` wrote that is below 1 PLN, the least ShipX collects or insures [18153492]. */
export function isBelowOneZloty(amount: string): boolean {
  return amount.split('.')[0] === '0'
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
  if (amount === null) return refuse('cod_amount_invalid')
  if (isBelowOneZloty(amount)) return refuse('cod_amount_too_small')
  return { ok: true, value: { amount, currency: 'PLN' } }
}

/**
 * Cash on delivery, insured for the same amount. The parameter table asks for insurance with cash on delivery for
 * courier services only, but ShipX's own locker example sends it and three FAQ pages say "the package must be
 * insured for a minimum of the COD value" without naming a service: so every service gets it.
 */
function insuredCashOnDelivery(cod: ShipxMoney | null): Pick<ShipxShipmentBody, 'insurance' | 'cod'> {
  return cod === null ? {} : { insurance: cod, cod }
}

/**
 * A Shipment request as a ShipX shipment, or the code it is refused with before any request is made. `reference`
 * is last on purpose: it is the key a repeated create is found by, and it must come back exactly as it was sent.
 */
export function toShipxShipment(request: ShipmentRequest, config: Pick<InpostConfig, 'lockerSendingMethod' | 'courierSendingMethod'>): Mapped<ShipxShipmentBody> {
  const { reference, destination, parcel } = request
  // ShipX takes 3 to 100 characters. The SDK's request has at most 64 letters, digits, `_` and `-`, so nothing ShipX
  // would cut or trim (an altered reference is never found again); only its lower bound is left to check.
  if (reference.length < 3) return refuse('reference_unsupported')
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
        ...insuredCashOnDelivery(cod.value),
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
      ...insuredCashOnDelivery(cod.value),
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


// A ShipX status name: lower-case words joined by `_`, digits allowed (`express_1000` style names exist for services).
const STATUS_KEY = /^[a-z][a-z0-9_]{0,59}$/
// An error key from inside a resource (a payment's error, an offer's unavailability reason). Letters and `_` only:
// a key that carried digits could carry a phone number or a locker code, and these are stored with the Shipment.
const ERROR_KEY = /^[a-z][a-z_]{1,59}$/

export function isStatusKey(value: unknown): value is string {
  return typeof value === 'string' && STATUS_KEY.test(value)
}

export function isErrorKey(value: unknown): value is string {
  return typeof value === 'string' && ERROR_KEY.test(value)
}

/** Offer statuses in which the offer can never be bought. Any other (`available`, `selected`, one InPost adds) still can. */
const DEAD_OFFER_STATUSES: readonly string[] = ['unavailable', 'expired']

/**
 * What stands between a shipment and its purchase, or null when nothing does (or the purchase is over).
 *
 * `final` only when no offer can still be bought: every offer for the shipment's service is `unavailable` or
 * `expired`. A payment that failed is not final. ShipX keeps the offer `selected` after an unsuccessful payment
 * [18153611], and the sandbox showed exactly that (no funds: `offer_selected`, a `failure` transaction with
 * `debt_collection`, the offer still `selected`): a later payment would buy a label for a Shipment Hanza had
 * given up on, and the seller's replacement would be a second parcel. So that Shipment waits, and `key` says why.
 */
export function purchaseObstacle(shipment: ShipxShipment): { final: boolean; key: string } | null {
  if (!PURCHASE_STATUSES.includes(shipment.status)) return null
  const offers = shipment.offers ?? []
  const own = offers.filter((offer) => offer.service?.id === shipment.service)
  const candidates = own.length > 0 ? own : offers
  if (candidates.length > 0 && candidates.every((offer) => DEAD_OFFER_STATUSES.includes(offer.status))) {
    const reason = candidates.flatMap((offer) => offer.unavailability_reasons ?? []).find((item) => isErrorKey(item.key))
    const fallback = candidates.every((offer) => offer.status === 'expired') ? 'offer_expired' : 'offer_unavailable'
    return { final: true, key: reason?.key ?? fallback }
  }
  const transactions = shipment.transactions ?? []
  if (transactions.some((transaction) => transaction.status === 'success' || transaction.status === 'initiated')) return null
  const failed = transactions.findLast((transaction) => transaction.status === 'failure')
  if (failed === undefined) return null
  const key = failed.details?.error
  return { final: false, key: isErrorKey(key) ? key : 'transaction_failure' }
}

/** True for a status name the table has, whatever it translates to. */
export function isKnownStatus(status: string): boolean {
  return Object.hasOwn(INPOST_STATUSES, status)
}

function shipmentState(shipment: ShipxShipment, status: ShipmentState['status'], carrierStatus: string | null): ShipmentState {
  const state = shipmentStateSchema.safeParse({ externalId: shipment.id, status, trackingNumber: shipment.tracking_number || null, carrierStatus })
  // Paths only: the resource this came from holds the receiver's data.
  if (!state.success) throw new PermanentError(`An InPost shipment does not fit the canonical model: ${state.error.issues.map((issue) => issue.path.join('.')).join(', ')}`, { cause: state.error })
  return state.data
}

/**
 * A ShipX shipment as a Shipment state. Null when its status says nothing this connector can translate (a name
 * InPost added, or one known not to say where the parcel is): the caller leaves the Shipment as it is instead of
 * guessing.
 */
export function toShipmentState(shipment: ShipxShipment): ShipmentState | null {
  const translated = isKnownStatus(shipment.status) ? INPOST_STATUSES[shipment.status] : null
  if (translated == null) return null
  const obstacle = purchaseObstacle(shipment)
  return shipmentState(shipment, obstacle?.final ? 'failed' : translated, obstacle?.key ?? shipment.status)
}

/**
 * The least that is true of a shipment whose status cannot be translated: InPost has it (`pending`), and with a
 * tracking number InPost has bought its label (`ready`). For `shipments.create`, which has to answer for a shipment
 * that exists. Never a status that says the Carrier holds the parcel: that would ship the Order on a guess.
 */
export function lowerBoundState(shipment: ShipxShipment): ShipmentState {
  return shipmentState(shipment, shipment.tracking_number ? 'ready' : 'pending', isStatusKey(shipment.status) ? shipment.status : null)
}
