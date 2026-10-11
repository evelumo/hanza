// Test and recording tooling only: never imported by the connector itself.
import type { ScrubConfig } from '@hanza/connector-sdk/testing'

/**
 * What a recording of Medusa must lose. Keys are matched anywhere in a body, ignoring case, `-` and `_`.
 * `country_code` is not here on purpose: the canonical address needs a real two-letter code. The addresses are listed
 * field by field for the same reason (a key that holds an object would scrub the country below it). `customer` holds
 * an object, so everything below it goes (its phone is read as a fallback; a placeholder serves as well).
 */
export const medusaScrub: ScrubConfig = {
  keys: {
    first_name: 'text',
    last_name: 'text',
    company: 'text',
    address_1: 'text',
    address_2: 'text',
    city: 'text',
    province: 'text',
    postal_code: 'text',
    phone: 'phone',
    email: 'email',
    customer: 'text',
    // Payment providers, plugins and merchants keep anything in metadata and provider data. The connector reads none of it.
    metadata: 'text',
    data: 'text',
  },
}
