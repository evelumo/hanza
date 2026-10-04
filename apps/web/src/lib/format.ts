import type { Money } from '@hanza/connector-sdk'

// The server's own zone is UTC in a container; the panel's users are in Poland.
const dateTime = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Warsaw' })

export function formatDateTime(date: Date): string {
  return dateTime.format(date)
}

/** Formats the decimal string as is (never a float); up to 4 decimals are shown, so nothing is rounded away on screen. */
export function formatMoney(money: Money): string {
  try {
    const format = new Intl.NumberFormat('pl-PL', { style: 'currency', currency: money.currency, maximumFractionDigits: 4 }).format as (value: string) => string
    return format(money.amount)
  } catch {
    return `${money.amount} ${money.currency}`
  }
}
