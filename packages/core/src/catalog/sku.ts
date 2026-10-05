/** SKUs are compared exactly and case-sensitively, after trimming. */
export function normalizeSku(sku: string | null | undefined): string | null {
  const trimmed = sku?.trim()
  return trimmed ? trimmed : null
}
