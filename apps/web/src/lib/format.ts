import type { Money } from '@hanza/connector-sdk'

const dateTime = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'short', timeStyle: 'short' })

export function formatDateTime(date: Date): string {
  return dateTime.format(date)
}

/** Formats the decimal string as is: amounts are never converted to floats. */
export function formatMoney(money: Money): string {
  try {
    const format = new Intl.NumberFormat('pl-PL', { style: 'currency', currency: money.currency }).format as (value: string) => string
    return format(money.amount)
  } catch {
    return `${money.amount} ${money.currency}`
  }
}
