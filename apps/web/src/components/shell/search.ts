/** The shortest text the command palette looks Products up for: one letter matches nearly everything. */
export const PALETTE_MIN_QUERY = 2

/** As long as the Products list's own search box takes. */
export const PALETTE_MAX_QUERY = 100

/** How many direct results of one kind the palette shows; the rest is one Enter away in the Products list. */
export const PALETTE_RESULTS = 5

export interface PaletteResults {
  /** Ids, SKUs and names only: nothing a list of search results has no need of, and never Buyer data. */
  products: Array<{ id: string; sku: string; name: string }>
}
