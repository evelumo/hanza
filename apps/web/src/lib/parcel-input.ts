/**
 * Reads a decimal a person typed ("30", "30.5", "30,5") as a whole number of the unit `places` decimal places
 * smaller. By its digits, never through a float: 0.3 kg is 300 g, not 299.99… rounded one way or the other. More
 * decimal places than the smaller unit has are refused, not rounded, and so is anything that is not above zero.
 */
function scaled(raw: string, places: number): number | null {
  const match = new RegExp(`^(\\d{1,4})(?:[.,](\\d{1,${places}}))?$`).exec(raw.trim())
  if (!match) return null
  const value = Number(match[1]! + (match[2] ?? '').padEnd(places, '0'))
  return value > 0 ? value : null
}

/** Centimetres as typed, to the millimetre, in millimetres; null when it is not a length below 100 m. */
export function centimetresToMillimetres(raw: string): number | null {
  return scaled(raw, 1)
}

/** Kilograms as typed, to the gram, in grams; null when it is not a weight below 10 t. */
export function kilogramsToGrams(raw: string): number | null {
  return scaled(raw, 3)
}
