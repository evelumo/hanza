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
