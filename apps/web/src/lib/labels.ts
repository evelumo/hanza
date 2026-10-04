import type { OrderStatus } from '@hanza/connector-sdk'
import type { AttentionReason, ChannelFactType, ConnectionHealth, PaymentMethod, SyncErrorKind, SyncStream } from '@hanza/db'

export const orderStatusLabels: Record<OrderStatus, string> = {
  new: 'Nowe',
  processing: 'W realizacji',
  shipped: 'Wysłane',
  cancelled: 'Anulowane',
}

export const attentionReasonLabels: Record<AttentionReason, string> = {
  unmatched_line: 'Niepołączona pozycja',
  shortage: 'Brak na stanie',
  cancelled_while_processing: 'Anulowane w trakcie realizacji',
  channel_fact_conflict: 'Kanał zgłosił zmianę po zakończeniu',
}

export const healthLabels: Record<ConnectionHealth, string> = {
  unknown: 'Nie sprawdzono',
  ok: 'Działa',
  failing: 'Błąd',
  auth_expired: 'Wymaga ponownego logowania',
}

export const streamLabels: Record<SyncStream, string> = {
  offers_pull: 'Oferty',
  orders_pull: 'Zamówienia',
  stock_push: 'Stany magazynowe',
  order_status_push: 'Statusy zamówień',
}

export const paymentLabels: Record<PaymentMethod, string> = {
  prepaid: 'Opłacone',
  cash_on_delivery: 'Za pobraniem',
}

export const factLabels: Record<ChannelFactType, string> = {
  cancelled: 'Anulowane w kanale',
  shipped: 'Wysłane w kanale',
}

export const reservationLabels = {
  open: 'Otwarta',
  released: 'Zwolniona',
  consumed: 'Zużyta',
} as const

export const syncErrorLabels: Record<SyncErrorKind, string> = {
  auth_expired: 'Wymagane ponowne logowanie',
  rate_limited: 'Limit zapytań kanału',
  transient: 'Błąd tymczasowy',
  permanent: 'Błąd trwały',
}

export const connectorKindLabels: Record<string, string> = {
  marketplace: 'Marketplace',
  shop: 'Sklep',
  courier: 'Kurier',
  invoicing: 'Fakturowanie',
}

/** Keys of `sync_state.lastResult` written by the sync jobs. */
export const syncResultLabels: Record<string, string> = {
  seen: 'widziane',
  created: 'nowe',
  updated: 'zaktualizowane',
  linked: 'połączone',
  pulled: 'pobrane',
  imported: 'zaimportowane',
  factsApplied: 'zmiany z kanału',
  pages: 'strony',
  pushed: 'wysłane',
  truncated: 'przerwane na limicie stron',
}

/** Lookup that never throws on a value this build does not know yet. */
export function labelOf(labels: Record<string, string>, value: string): string {
  return labels[value] ?? value
}
