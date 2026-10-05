export const PAGE_SIZE = 50

type RawParam = string | string[] | undefined

export function firstParam(value: RawParam): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** 1-based page from `?page=`; anything that is not a positive integer is page 1. */
export function parsePage(value: RawParam): number {
  const raw = firstParam(value)
  if (!raw || !/^\d{1,6}$/.test(raw)) return 1
  return Math.max(1, Number(raw))
}

export function pageWindow(page: number): { skip: number; take: number } {
  return { skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }
}

export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / PAGE_SIZE))
}

/** The page to show: a `?page=` past the end is the last page. */
export function clampPage(page: number, total: number): number {
  return Math.min(page, pageCount(total))
}

/** Previous page, or null on the first one; never past the end, so "Previous" from `?page=999` lands on the last page. */
export function previousPage(page: number, total: number): number | null {
  return page > 1 ? Math.min(page - 1, pageCount(total)) : null
}

export function nextPage(page: number, total: number): number | null {
  return page < pageCount(total) ? page + 1 : null
}

export function pageHref(basePath: string, params: Record<string, string | undefined>, page: number): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value)
  if (page > 1) search.set('page', String(page))
  const query = search.toString()
  return query ? `${basePath}?${query}` : basePath
}

/** Where to send a request for a page past the end (keeping the other params), or null when the page exists. */
export function outOfRangeRedirect(
  page: number,
  total: number,
  basePath: string,
  params: Record<string, string | undefined> = {},
): string | null {
  const last = clampPage(page, total)
  return last === page ? null : pageHref(basePath, params, last)
}
