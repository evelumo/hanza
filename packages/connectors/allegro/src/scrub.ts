import type { ScrubConfig } from '@hanza/connector-sdk/testing'

// The invoice company's name and tax ids, wherever a checkout form sits: a single form, or a list page (arrays are
// transparent in paths). Not by key: `name` is also an Offer's name, `value` and `ids` appear elsewhere, and the
// tax id types (`PL_NIP`) must survive for the mapping to be tested.
const COMPANY_PATHS = ['invoice.address.company', 'checkoutForms.invoice.address.company'].flatMap((company) => [
  `${company}.name`,
  `${company}.ids.value`,
])

/**
 * Every personal field Allegro sends in the responses the connector reads (checkout forms, order events, `/me`):
 * names, addresses, contact data, logins, the PESEL and the Buyer's free text. Tokens, client credentials, the
 * device and user codes, `Bearer`/`Basic` values, JWTs, e-mails and `+` phone numbers are scrubbed by the SDK's
 * defaults; `email` and `phoneNumber` are named anyway so a value that does not look like one is caught too.
 */
export const allegroScrub: ScrubConfig = {
  keys: {
    firstName: 'text',
    lastName: 'text',
    companyName: 'text',
    street: 'text',
    zipCode: 'text',
    postCode: 'text',
    city: 'text',
    phoneNumber: 'phone',
    email: 'email',
    login: 'text',
    personalIdentity: 'text',
    messageToSeller: 'text',
    // The seller's own note on an Order, free text that may quote the Buyer.
    note: 'text',
  },
  paths: Object.fromEntries(COMPANY_PATHS.map((path) => [path, 'text' as const])),
  // The Order feed takes its boundary from the `Date` of `GET /order/event-stats`: kept, a replay starts at the same time.
  keepResponseHeaders: ['date'],
}
