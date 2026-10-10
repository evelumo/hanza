import { ChevronLeft, ChevronRight } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { useT } from '@/i18n/use-t'
import { clampPage, nextPage, pageCount, pageHref, previousPage } from '@/lib/pagination'
import { cn } from '@/lib/utils'
import { buttonClass } from './button-class'

// A link when there is a page to go to; otherwise the same shape, inert, so the pair does not jump around.
function PageLink({ href, children }: { href: string | null; children: ReactNode }) {
  const className = buttonClass('secondary', 'sm')
  return href ? (
    <Link href={href} className={className}>
      {children}
    </Link>
  ) : (
    <span aria-disabled="true" className={cn(className, 'cursor-default')}>
      {children}
    </span>
  )
}

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
  const t = useT()
  const pages = pageCount(total)
  const previous = previousPage(page, total)
  const next = nextPage(page, total)
  return (
    <nav aria-label={t('pagination.label')} className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-meta text-muted-foreground tabular-nums">{t('pagination.summary', { total, page: clampPage(page, total), pages })}</p>
      {pages > 1 ? (
        <div className="flex gap-2">
          <PageLink href={previous ? pageHref(basePath, params, previous) : null}>
            <ChevronLeft aria-hidden="true" />
            {t('pagination.previous')}
          </PageLink>
          <PageLink href={next ? pageHref(basePath, params, next) : null}>
            {t('pagination.next')}
            <ChevronRight aria-hidden="true" />
          </PageLink>
        </div>
      ) : null}
    </nav>
  )
}
