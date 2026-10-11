// Test and recording tooling only: never imported by the connector itself.
import type { ScrubConfig } from '@hanza/connector-sdk/testing'

/**
 * What a recording of WooCommerce must lose. Keys are matched anywhere in a body, ignoring case, `-` and `_`.
 * `country` is not here on purpose: the canonical address needs a real two-letter code, and a country says nothing
 * about a person. The addresses are listed field by field for the same reason (a key that holds an object would
 * scrub the country below it).
 */
export const woocommerceScrub: ScrubConfig = {
  keys: {
    // billing and shipping
    first_name: 'text',
    last_name: 'text',
    company: 'text',
    address_1: 'text',
    address_2: 'text',
    city: 'text',
    state: 'text',
    postcode: 'text',
    phone: 'phone',
    email: 'email',
    // the order itself
    customer_note: 'text',
    customer_ip_address: 'text',
    customer_user_agent: 'text',
    transaction_id: 'text',
    cart_hash: 'text',
    // Lets anybody open the order's payment page; as a secret it is also removed from `payment_url`.
    order_key: 'secret',
    // A refund's reason is free text written by the seller.
    reason: 'text',
    // Plugins keep tax ids, parcel-locker choices and tracking numbers in meta. The connector reads none of it.
    meta_data: 'text',
  },
  // `date` is the shop's clock the Order feed reads; the totals tell a list's last page.
  keepResponseHeaders: ['date', 'x-wp-total', 'x-wp-totalpages'],
}
