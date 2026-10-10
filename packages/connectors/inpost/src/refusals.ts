// What a 4xx answer to `POST /v1/organizations/{id}/shipments` means. Codes are stored with the Shipment in
// plaintext and never erased, so every part of one comes from the lists in this file, never from the answer itself:
// ShipX does echo input in its keys (`{"shipment":["id_abc_does_not_exist"]}` for `?id=abc`, sandbox 2026-10-10).

/** Field names this connector sends. A path through anything else is not about this request's fields. */
const SENT_FIELDS: ReadonlySet<string> = new Set([
  'receiver',
  'company_name',
  'first_name',
  'last_name',
  'email',
  'phone',
  'address',
  'line1',
  'city',
  'post_code',
  'country_code',
  'parcels',
  'template',
  'id',
  'dimensions',
  'length',
  'width',
  'height',
  'unit',
  'weight',
  'amount',
  'is_non_standard',
  'insurance',
  'cod',
  'currency',
  'custom_attributes',
  'sending_method',
  'target_point',
  'service',
  'reference',
])

// Left out of a code: ShipX nests `target_point` under it (`{"custom_attributes":[{"target_point":[…]}]}`), its FAQ
// shows the field flat, and both are to give `target_point.does_not_exist`.
const WRAPPER_FIELDS: ReadonlySet<string> = new Set(['custom_attributes'])

/** The validation keys of the documentation [18153492] and its FAQ [451903492], and the two numeric ones ShipX uses. */
const VALIDATION_KEYS: ReadonlySet<string> = new Set([
  'required',
  'invalid',
  'invalid_format',
  'too_short',
  'too_long',
  'too_small',
  'too_big',
  'not_a_number',
  'not_an_integer',
  'does_not_exist',
  'invalid_box_machine_function',
])

const VALIDATION_FAILED = 'validation_failed'
const MAX_CODE_LENGTH = 100
const MAX_DEPTH = 8

function findCode(node: unknown, path: readonly string[], depth: number): string | null {
  if (depth > MAX_DEPTH) return null
  if (typeof node === 'string') return path.length > 0 && VALIDATION_KEYS.has(node) ? [...path, node].join('.') : null
  if (Array.isArray(node)) {
    // An array is a list of keys, or of nested forms: its indexes say nothing a person could act on.
    for (const item of node) {
      const code = findCode(item, path, depth + 1)
      if (code !== null) return code
    }
    return null
  }
  if (typeof node !== 'object' || node === null) return null
  for (const [name, value] of Object.entries(node)) {
    const fields = name.split('.')
    if (!fields.every((field) => SENT_FIELDS.has(field))) continue
    const code = findCode(value, [...path, ...fields.filter((field) => !WRAPPER_FIELDS.has(field))], depth + 1)
    if (code !== null) return code
  }
  return null
}

/**
 * The code of a `validation_failed` answer: the first field of the request that `details` names with a known
 * validation key, as `receiver.phone.invalid` or `target_point.does_not_exist`. `validation_failed` for anything
 * else: a field this connector does not send, a key outside the list, a sentence, a number.
 */
export function rejectionCode(details: unknown): string {
  const code = findCode(details, [], 0)
  return code === null || code.length > MAX_CODE_LENGTH ? VALIDATION_FAILED : code
}

/**
 * Error keys that refuse this one request, with the code each is rejected with. Both say the account does not have
 * the service the request names, which by the SDK's contract is something wrong with the request: another service
 * would work, and the person chooses it in a new Shipment. Nothing was made at InPost, so failing this one Shipment
 * for good loses nothing, while a Connection marked failing would hold back the Shipments that have nothing wrong.
 *
 * - `carrier_unavailable`: "no carriers contracted providing the requested service" [18153501].
 * - `missing_trucker_id`: what the sandbox answers `inpost_courier_standard` on an account without a courier
 *   contract (2026-10-10), with the FAQ's `trucker_ID_is_not_set_for_organization` as its message. Both spellings
 *   give the one code.
 */
const REQUEST_REFUSALS: Readonly<Record<string, string>> = {
  carrier_unavailable: 'carrier_unavailable',
  missing_trucker_id: 'missing_trucker_id',
  trucker_id_is_not_set_for_organization: 'missing_trucker_id',
}

/**
 * Error keys that refuse the whole account: every Shipment would get the same answer, whatever its service. These
 * are thrown, never `rejected`, so the Shipment waits for a person to fix the account.
 *
 * - `debt_collection`: unpaid invoices, or no credit on a prepaid account [451903492, 53706753].
 * - `no_carriers`: "the organization has no carriers contracted" [18153501].
 */
const ACCOUNT_REFUSALS: readonly string[] = ['debt_collection', 'no_carriers']

/**
 * `rejected`: InPost refuses this request for good, with the code to store.
 * `account`: InPost refuses the account; `key` is one of this connector's own constants.
 * `unknown`: an error key this connector has no entry for.
 */
export type CreateRefusal = { kind: 'rejected'; code: string } | { kind: 'account'; key: string } | { kind: 'unknown' }

export function createRefusal(error: { error: string; details?: unknown }): CreateRefusal {
  const key = error.error.toLowerCase()
  if (key === VALIDATION_FAILED) return { kind: 'rejected', code: rejectionCode(error.details) }
  if (Object.hasOwn(REQUEST_REFUSALS, key)) return { kind: 'rejected', code: REQUEST_REFUSALS[key]! }
  const account = ACCOUNT_REFUSALS.find((known) => known === key)
  return account === undefined ? { kind: 'unknown' } : { kind: 'account', key: account }
}
