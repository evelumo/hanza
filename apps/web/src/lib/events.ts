import { moneySchema, type Money } from '@hanza/connector-sdk'
import { hasLabel, labelOrRaw } from './labels'
import type { Translator } from '@/i18n/types'

type Payload = Record<string, unknown>

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const count = (value: unknown): number | null => (typeof value === 'number' ? value : null)

function arrow(from: string | null, to: string | null): string | null {
  return from !== null && to !== null ? `${from} → ${to}` : null
}

function nested(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Payload)[key] : undefined
}

type NumberFormat = (value: number) => string
type MoneyFormat = (money: Money) => string

export interface EventFormatters {
  number: NumberFormat
  money: MoneyFormat
}

// The payload is untrusted, so only a well-formed price is shown; null means "no price".
function priceText(t: Translator, money: MoneyFormat, value: unknown): string | null {
  if (value === null) return t('prices.none')
  const parsed = moneySchema.safeParse(value)
  return parsed.success ? money(parsed.data) : null
}

const formatted = (value: unknown, number: NumberFormat): string | null => {
  const n = count(value)
  return n === null ? null : number(n)
}

// Payloads are untrusted JSON, and a status or reason this build does not know yet is shown as it is.
function detail(t: Translator, format: EventFormatters, type: string, payload: Payload): string | null {
  const { number } = format
  switch (type) {
    case 'stock.set':
      return arrow(formatted(payload.from, number), formatted(payload.to, number))
    case 'stock.reserved':
    case 'stock.released':
    case 'stock.consumed':
    case 'order.reservation_moved': {
      const units = count(payload.units)
      return units ? t('common.units', { count: units }) : null
    }
    case 'family.created':
    case 'family.deleted':
      return text(payload.name)
    case 'family.renamed':
      return arrow(text(nested(payload.name, 'from')), text(nested(payload.name, 'to')))
    case 'family.product_added':
    case 'family.product_updated':
    case 'family.product_removed':
      return text(payload.sku)
    case 'connection.warehouses_changed': {
      const to = nested(payload, 'to')
      const all = nested(to, 'all')
      const ids = nested(to, 'warehouseIds')
      if (all === true) return t('events.allWarehouses')
      return all === false && Array.isArray(ids) ? t('events.someWarehouses', { count: ids.length }) : null
    }
    case 'warehouse.created':
    case 'warehouse.deleted':
      return text(payload.name)
    case 'warehouse.updated': {
      const side = (key: 'from' | 'to', field: string) => nested(nested(payload, key), field)
      const from = text(side('from', 'name'))
      const to = text(side('to', 'name'))
      if (from !== null && to !== null && from !== to) return arrow(from, to)
      const priority = arrow(formatted(side('from', 'priority'), number), formatted(side('to', 'priority'), number))
      return priority ? t('events.priority', { change: priority }) : null
    }
    case 'product.updated':
      return arrow(text(nested(payload.name, 'from')), text(nested(payload.name, 'to')))
    case 'product.price_changed':
    case 'offer.price_changed':
      return arrow(priceText(t, format.money, payload.from), priceText(t, format.money, payload.to))
    case 'order.status_changed':
      return arrow(statusName(t, payload.fromStatus, text(payload.from)), statusName(t, payload.toStatus, text(payload.to)))
    case 'connection.status_mapping_changed': {
      const phase = text(payload.phase)
      const change = arrow(mappedName(t, payload.from, phase), mappedName(t, payload.to, phase))
      return phase && change ? `${labelOrRaw(t, 'labels.orderPhase', phase)}: ${change}` : change
    }
    case 'order.channel_fact_recorded':
      return labelOrRaw(t, 'labels.channelFact', text(payload.type) ?? '')
    case 'order.attention_raised':
    case 'order.attention_resolved': {
      const reasons = payload.reasons ?? payload.cleared
      return Array.isArray(reasons) ? reasons.map((reason) => labelOrRaw(t, 'labels.attentionReason', String(reason))).join(', ') : null
    }
    case 'order.imported': {
      const lines = count(payload.lineCount)
      return lines ? t('events.lines', { count: lines }) : null
    }
    case 'connection.health_changed':
      return arrow(healthLabel(t, text(payload.from)), healthLabel(t, text(payload.to)))
    case 'connection.signed_in':
      return text(payload.account)
    case 'order.buyer_data_erased': {
      const cause = text(payload.cause)
      return cause === null ? null : labelOrRaw(t, 'labels.erasureCause', cause)
    }
    case 'privacy.retention_changed':
      return arrow(retentionLabel(t, payload.from), retentionLabel(t, payload.to))
    case 'privacy.erasure_requested': {
      const erased = count(payload.erased)
      return erased === null ? null : t('events.ordersErased', { count: erased })
    }
    case 'connection.stock_rules_changed': {
      const rule = (side: 'from' | 'to', key: string) => nested(nested(payload, side), key)
      const limit = (value: unknown) => (value === null ? t('common.none') : formatted(value, number))
      const buffer = arrow(formatted(rule('from', 'safetyBuffer'), number), formatted(rule('to', 'safetyBuffer'), number))
      const cap = arrow(limit(rule('from', 'channelLimit')), limit(rule('to', 'channelLimit')))
      return buffer && cap ? t('events.stockRules', { buffer, limit: cap }) : null
    }
    default:
      return null
  }
}

const phaseLabel = (t: Translator, value: string | null) => (value === null ? null : labelOrRaw(t, 'labels.orderPhase', value))

/**
 * The status name kept in the Event (renaming the status later does not change it). An unnamed status (a default) is
 * shown as its phase, in the viewer's language: the snapshot's own phase, else the phase the Event names.
 */
function statusName(t: Translator, snapshot: unknown, phase: string | null): string | null {
  if (typeof snapshot !== 'object' || snapshot === null) return phaseLabel(t, phase)
  const { name, phase: own } = snapshot as Payload
  return text(name) ?? phaseLabel(t, text(own) ?? phase)
}

/** A Status mapping side: no status at all is "the phase default"; an unnamed status is shown as its phase. */
function mappedName(t: Translator, snapshot: unknown, phase: string | null): string {
  if (typeof snapshot !== 'object' || snapshot === null) return t('events.defaultStatus')
  return statusName(t, snapshot, phase) ?? t('events.defaultStatus')
}
const healthLabel = (t: Translator, value: string | null) => (value === null ? null : labelOrRaw(t, 'labels.health', value))

/** Null in the payload means retention off; anything that is not a number is unknown. */
function retentionLabel(t: Translator, value: unknown): string | null {
  if (value === null) return t('events.retentionOff')
  const days = count(value)
  return days === null ? null : t('events.retentionDays', { count: days })
}

/** Event types have dots, which message keys cannot contain: `order.status_changed` is `order_status_changed`. */
const titleKey = (type: string) => type.replaceAll('.', '_')

/**
 * One-liner for an Event in the request's language; payloads are untrusted JSON, so every field is type-checked.
 * `format` holds the locale's number and money formatters (`getFormatters()`).
 */
export function describeEvent(
  type: string,
  payload: Payload,
  t: Translator,
  format: EventFormatters,
): { title: string; detail: string | null } {
  const result = detail(t, format, type, payload)
  const title = hasLabel('events.title', titleKey(type)) ? labelOrRaw(t, 'events.title', titleKey(type)) : type
  return { title, detail: result && result.trim() !== '' ? result : null }
}
