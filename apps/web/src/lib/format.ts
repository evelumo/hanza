import type { Money } from '@hanza/connector-sdk'
import { PANEL_TIME_ZONE, formatLocales, type Locale } from '@/i18n/config'

const dateTimeFormats = new Map<Locale, Intl.DateTimeFormat>()
const numberFormats = new Map<Locale, Intl.NumberFormat>()

export function formatDateTime(date: Date, locale: Locale): string {
  let format = dateTimeFormats.get(locale)
  if (!format) {
    format = new Intl.DateTimeFormat(formatLocales[locale], { dateStyle: 'short', timeStyle: 'short', timeZone: PANEL_TIME_ZONE })
    dateTimeFormats.set(locale, format)
  }
  return format.format(date)
}

export function formatNumber(value: number, locale: Locale): string {
  let format = numberFormats.get(locale)
  if (!format) {
    format = new Intl.NumberFormat(formatLocales[locale])
    numberFormats.set(locale, format)
  }
  return format.format(value)
}

/** Formats the decimal string as is (never a float); up to 4 decimals are shown, so nothing is rounded away on screen. */
export function formatMoney(money: Money, locale: Locale): string {
  try {
    const format = new Intl.NumberFormat(formatLocales[locale], { style: 'currency', currency: money.currency, maximumFractionDigits: 4 })
      .format as (value: string) => string
    return format(money.amount)
  } catch {
    return `${money.amount} ${money.currency}`
  }
}

export interface Formatters {
  dateTime: (date: Date) => string
  number: (value: number) => string
  money: (money: Money) => string
}

/** The three formatters bound to one locale, so a page asks for them once. */
export function createFormatters(locale: Locale): Formatters {
  return {
    dateTime: (date) => formatDateTime(date, locale),
    number: (value) => formatNumber(value, locale),
    money: (money) => formatMoney(money, locale),
  }
}
