import Link from 'next/link'
import { pageCount } from '@/lib/pagination'

function href(basePath: string, params: Record<string, string | undefined>, page: number): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value)
  if (page > 1) search.set('page', String(page))
  const query = search.toString()
  return query ? `${basePath}?${query}` : basePath
}

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
  return (
    <nav aria-label="Paginacja" className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted">
        Razem: {total} · Strona {Math.min(page, pages)} z {pages}
      </span>
      <span className="flex gap-2">
        {page > 1 ? (
          <Link href={href(basePath, params, page - 1)} className={linkClass}>
            Poprzednia
          </Link>
        ) : null}
        {page < pages ? (
          <Link href={href(basePath, params, page + 1)} className={linkClass}>
            Następna
          </Link>
        ) : null}
      </span>
    </nav>
  )
}
