import Link from 'next/link'
import { clampPage, nextPage, pageCount, pageHref, previousPage } from '@/lib/pagination'

const linkClass = 'rounded-md border border-line bg-white px-3 py-1.5 font-medium hover:bg-canvas focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40'

/** Previous / next links that keep the other query parameters (filters, search). */
export function Pagination({
  page,
  total,
  basePath,
  params = {},
}: {
  page: number
  total: number
  basePath: string
  params?: Record<string, string | undefined>
}) {
  const pages = pageCount(total)
  const previous = previousPage(page, total)
  const next = nextPage(page, total)
  return (
    <nav aria-label="Paginacja" className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted">
        Razem: {total} · Strona {clampPage(page, total)} z {pages}
      </span>
      <span className="flex gap-2">
        {previous ? (
          <Link href={pageHref(basePath, params, previous)} className={linkClass}>
            Poprzednia
          </Link>
        ) : null}
        {next ? (
          <Link href={pageHref(basePath, params, next)} className={linkClass}>
            Następna
          </Link>
        ) : null}
      </span>
    </nav>
  )
}
