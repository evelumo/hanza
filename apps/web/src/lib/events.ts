import { attentionReasonLabels, factLabels, healthLabels, labelOf, orderStatusLabels } from './labels'

const titles: Record<string, string> = {
  'system.ping': 'Zadanie testowe',
  'product.created': 'Utworzono produkt',
  'product.updated': 'Zmieniono nazwę produktu',
  'stock.set': 'Ustawiono stan',
  'stock.reserved': 'Zarezerwowano towar',
  'stock.released': 'Zwolniono rezerwację',
  'stock.consumed': 'Pobrano towar ze stanu',
  'offer.linked': 'Połączono ofertę z produktem',
  'offer.unlinked': 'Rozłączono ofertę z produktem',
  'order.imported': 'Zaimportowano zamówienie',
  'order.channel_fact_recorded': 'Kanał zgłosił zmianę',
  'order.status_changed': 'Zmieniono status',
  'order.line_linked': 'Połączono pozycję z produktem',
  'order.attention_raised': 'Zamówienie wymaga uwagi',
  'order.attention_resolved': 'Oznaczono jako sprawdzone',
  'connection.created': 'Utworzono połączenie',
  'connection.health_changed': 'Zmienił się stan połączenia',
}

type Payload = Record<string, unknown>

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const count = (value: unknown): string | null => (typeof value === 'number' ? String(value) : null)

function arrow(from: string | null, to: string | null): string | null {
  return from !== null && to !== null ? `${from} → ${to}` : null
}

function nested(value: unknown, key: 'from' | 'to'): unknown {
  return typeof value === 'object' && value !== null ? (value as Payload)[key] : undefined
}

function detail(type: string, payload: Payload): string | null {
  switch (type) {
    case 'stock.set':
      return arrow(count(payload.from), count(payload.to))
    case 'stock.reserved':
    case 'stock.released':
    case 'stock.consumed': {
      const units = count(payload.units)
      return units ? `${units} szt.` : null
    }
    case 'product.updated':
      return arrow(text(nested(payload.name, 'from')), text(nested(payload.name, 'to')))
    case 'order.status_changed':
      return arrow(labelOf(orderStatusLabels, text(payload.from) ?? ''), labelOf(orderStatusLabels, text(payload.to) ?? ''))
    case 'order.channel_fact_recorded':
      return labelOf(factLabels, text(payload.type) ?? '')
    case 'order.attention_raised':
    case 'order.attention_resolved': {
      const reasons = payload.reasons ?? payload.cleared
      return Array.isArray(reasons) ? reasons.map((reason) => labelOf(attentionReasonLabels, String(reason))).join(', ') : null
    }
    case 'order.imported': {
      const lines = count(payload.lineCount)
      return lines ? `Pozycje: ${lines}` : null
    }
    case 'connection.health_changed':
      return arrow(labelOf(healthLabels, text(payload.from) ?? ''), labelOf(healthLabels, text(payload.to) ?? ''))
    default:
      return null
  }
}

/** Polish one-liner for an Event; payloads are untrusted JSON, so every field is type-checked. */
export function describeEvent(type: string, payload: Payload): { title: string; detail: string | null } {
  const result = detail(type, payload)
  return { title: titles[type] ?? type, detail: result && result.trim() !== '' ? result : null }
}
