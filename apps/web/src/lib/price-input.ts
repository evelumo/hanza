import { currencyMinorUnits } from '@hanza/connector-sdk'
import { messageKey } from '@/i18n/keys'
import type { MessageKey } from '@/i18n/types'

const INVALID = messageKey('validation.priceInvalid')
const AMBIGUOUS = messageKey('validation.priceAmbiguous')
const TOO_MANY_DECIMALS = messageKey('validation.priceTooManyDecimals')

const MAX_INTEGER_DIGITS = 15

/** Whole number written with `group` between thousands, e.g. "1.234.567". */
function ungroup(value: string, group: string): string | null {
  const parts = value.split(group)
  if (!/^\d{1,3}$/.test(parts[0]!) || parts.slice(1).some((part) => !/^\d{3}$/.test(part))) return null
  return parts.join('')
}

/**
 * Reads a price typed by a person in the currency it is for, as a decimal string (never a float). Spaces may group
 * thousands; with both "," and "." the last one is the decimal separator. One separator followed by exactly three
 * digits after 1-3 digits that do not start with 0 ("1,234", "1.234") could be either: it is thousands grouping in a
 * currency without decimals (1234 JPY), a decimal point in one with three or more (1.234 KWD), and refused as
 * ambiguous otherwise. No more decimal places than the currency has are accepted (45.5 JPY is refused, not rounded).
 */
export function parsePriceInput(raw: string, currency: string): { amount: string } | { error: MessageKey } {
  const value = raw.trim().replace(/[\s  ]/g, '')
  if (!/^\d[\d.,]*$/.test(value) || /[.,]$/.test(value)) return { error: INVALID }

  const minorUnits = currencyMinorUnits(currency)
  const lastDot = value.lastIndexOf('.')
  const lastComma = value.lastIndexOf(',')
  let integer: string | null
  let fraction = ''

  if (lastDot === -1 && lastComma === -1) {
    integer = value
  } else if (lastDot !== -1 && lastComma !== -1) {
    const decimal = lastDot > lastComma ? '.' : ','
    const at = value.lastIndexOf(decimal)
    integer = ungroup(value.slice(0, at), decimal === '.' ? ',' : '.')
    fraction = value.slice(at + 1)
  } else {
    const separator = lastDot !== -1 ? '.' : ','
    const parts = value.split(separator)
    if (parts.length > 2) {
      integer = ungroup(value, separator)
    } else {
      integer = parts[0]!
      fraction = parts[1]!
      // "0,001" or "1234,567" cannot be thousands grouping, so they are decimals (and usually too many of them).
      const couldBeGrouping = fraction.length === 3 && /^[1-9]\d{0,2}$/.test(integer)
      if (couldBeGrouping && minorUnits === 0) {
        integer += fraction
        fraction = ''
      } else if (couldBeGrouping && minorUnits <= 2) {
        return { error: AMBIGUOUS }
      }
    }
  }

  if (integer === null || !/^\d+$/.test(fraction || '0')) return { error: INVALID }
  if (fraction.length > minorUnits) return { error: TOO_MANY_DECIMALS }
  const significant = integer.replace(/^0+(?=\d)/, '')
  if (significant.length > MAX_INTEGER_DIGITS) return { error: INVALID }
  const amount = fraction ? `${significant}.${fraction}` : significant
  if (!/[1-9]/.test(amount)) return { error: INVALID }
  return { amount }
}
