// Exact arithmetic on non-negative decimal strings ("126.13"), for money: WooCommerce sends amounts as strings, and a
// float would lose cents. Every function returns null for an input that is not such a string (digits, optionally a dot
// and more digits, at most `MAX_DECIMAL_LENGTH` characters), instead of throwing.

/** The most fraction digits a canonical `Money` amount has. */
export const MONEY_FRACTION_DIGITS = 4
const MONEY_INTEGER_DIGITS = 15

const DECIMAL = /^\d+(\.\d+)?$/
/**
 * No amount of a real order comes near this many characters. The values come from the shop, and a megabyte of digits
 * would keep the worker busy converting and multiplying it.
 */
export const MAX_DECIMAL_LENGTH = 64

/** `units / 10^scale`. */
interface Decimal {
  units: bigint
  scale: number
}

function parse(value: string): Decimal | null {
  if (value.length > MAX_DECIMAL_LENGTH || !DECIMAL.test(value)) return null
  const [integer = '', fraction = ''] = value.split('.')
  return { units: BigInt(integer + fraction), scale: fraction.length }
}

function format({ units, scale }: Decimal): string {
  const digits = units.toString().padStart(scale + 1, '0')
  return scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`
}

function rescale(value: Decimal, scale: number): bigint {
  return value.units * 10n ** BigInt(scale - value.scale)
}

/** `numerator / denominator` rounded half-up; both non-negative. */
function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (2n * numerator + denominator) / (2n * denominator)
}

function round(value: Decimal, fractionDigits: number): Decimal {
  if (value.scale <= fractionDigits) return value
  return { units: divideHalfUp(value.units, 10n ** BigInt(value.scale - fractionDigits)), scale: fractionDigits }
}

function isFractionDigits(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 100
}

/** The exact sum, with as many fraction digits as the longer of the two: "9.99" + "0.01" = "10.00". */
export function addDecimal(a: string, b: string): string | null {
  const left = parse(a)
  const right = parse(b)
  if (left === null || right === null) return null
  const scale = Math.max(left.scale, right.scale)
  return format({ units: rescale(left, scale) + rescale(right, scale), scale })
}

/**
 * `value / divisor` for a positive whole `divisor`, rounded half-up to `fractionDigits` fraction digits. Zeros at the
 * end are dropped down to the fraction digits `value` came with, so an amount in cents stays one when it divides
 * evenly: "149.97" / 3 = "49.99", "100.00" / 3 = "33.3333", "100" / 4 = "25".
 */
export function divideDecimal(value: string, divisor: number, fractionDigits = MONEY_FRACTION_DIGITS): string | null {
  const parsed = parse(value)
  if (parsed === null || !Number.isSafeInteger(divisor) || divisor <= 0 || !isFractionDigits(fractionDigits)) return null
  // One division straight to the wanted digits: rounding twice (to the value's digits, then to fewer) can round up twice.
  let quotient: Decimal = {
    units: divideHalfUp(parsed.units * 10n ** BigInt(fractionDigits), BigInt(divisor) * 10n ** BigInt(parsed.scale)),
    scale: fractionDigits,
  }
  const keep = Math.min(parsed.scale, fractionDigits)
  while (quotient.scale > keep && quotient.units % 10n === 0n) {
    quotient = { units: quotient.units / 10n, scale: quotient.scale - 1 }
  }
  return format(quotient)
}

/**
 * `value` as a canonical `Money` amount (`/^\d{1,15}(\.\d{1,4})?$/`): rounded half-up to 4 fraction digits, without
 * zeros in front; a value that is short enough is returned as it is, zeros at its end included. Null when it has more
 * than 15 integer digits, or is not a non-negative decimal string.
 */
export function toMoneyAmount(value: string): string | null {
  const parsed = parse(value)
  if (parsed === null) return null
  const amount = format(round(parsed, MONEY_FRACTION_DIGITS))
  const integerDigits = amount.split('.')[0]!.length
  return integerDigits <= MONEY_INTEGER_DIGITS ? amount : null
}
