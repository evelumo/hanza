import { numberToDecimal } from '../decimal'

// Medusa keeps amounts as BigNumbers and sends each twice: a JSON number (`total`) and, on many fields, its raw twin
// (`raw_total: { value: "129.99", precision: 20 }`, major units). The raw value is the exact one.

const DECIMAL = /^\d+(\.\d+)?$/

/**
 * The amount as a non-negative decimal string: the raw twin's value when there is one, else the JSON number written
 * out string-safely (`numberToDecimal`), else null. A negative or malformed amount is null.
 */
export function amountOf(raw: { value: string | number } | null | undefined, number: number | string | null | undefined): string | null {
  if (raw !== null && raw !== undefined) {
    const value = typeof raw.value === 'number' ? numberToDecimal(raw.value) : raw.value.trim()
    return value !== null && DECIMAL.test(value) ? value : null
  }
  if (typeof number === 'number') return numberToDecimal(number)
  if (typeof number === 'string' && DECIMAL.test(number.trim())) return number.trim()
  return null
}

/** A count (a quantity): a whole number from the raw twin or the number; null for anything else. */
export function wholeNumberOf(raw: { value: string | number } | null | undefined, number: number | string): number | null {
  const text = amountOf(raw, number)
  if (text === null || !/^\d+(\.0+)?$/.test(text)) return null
  const value = Number(text)
  return Number.isSafeInteger(value) ? value : null
}
