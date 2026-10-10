import type { Messages } from './types'

/**
 * The part of the catalogue that client components read (via `useT`); everything else is rendered on the
 * server, so it is not sent to the browser. A client component that needs a new group must have it added
 * here — `client-messages.test.ts` fails when one is missing.
 */
export function clientMessages(messages: Messages) {
  return {
    common: messages.common,
    language: messages.language,
    nav: messages.nav,
    shell: messages.shell,
    pagination: messages.pagination,
    auth: messages.auth,
    offers: messages.offers,
    prices: { form: messages.prices.form },
    products: { columns: messages.products.columns, detail: messages.products.detail, new: messages.products.new },
    families: { new: messages.families.new, detail: messages.families.detail },
    orders: { linkLine: messages.orders.linkLine, moveReservation: messages.orders.moveReservation },
    connections: {
      new: messages.connections.new,
      stockRules: messages.connections.stockRules,
      warehouses: messages.connections.warehouses,
      detail: { statusMapping: messages.connections.detail.statusMapping },
    },
    warehouses: messages.warehouses,
    privacy: { retention: messages.privacy.retention, erasure: messages.privacy.erasure },
    settings: { orderStatuses: messages.settings.orderStatuses, system: messages.settings.system },
    errors: { page: messages.errors.page, notFound: messages.errors.notFound },
  } satisfies Partial<Record<keyof Messages, unknown>>
}
