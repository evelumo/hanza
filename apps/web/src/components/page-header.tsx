import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { useT } from '@/i18n/use-t'
import { buttonClass } from './button-class'

/**
 * The top of a page, with its only <h1>. `badges` sit beside the title (the state of the thing), `meta` is one
 * quiet line of facts under it (text, or nodes such as an `Identifier`), `description` explains the page,
 * `actions` go right with the primary one last. `back` points a detail page at its list. A title or a fact that
 * is one long unbroken word (a name without spaces, a 64-character SKU) wraps instead of widening the page.
 */
export function PageHeader({
  title,
  description,
  badges,
  meta,
  actions,
  back,
}: {
  title: ReactNode
  description?: ReactNode
  badges?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  back?: { href: string; label: string }
}) {
  const t = useT()
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="flex min-w-0 items-start gap-2">
        {back ? (
          <Link href={back.href} aria-label={t('common.backTo', { page: back.label })} className={`${buttonClass('ghost')} -ml-1.5 w-8 px-0`}>
            <ArrowLeft aria-hidden="true" />
          </Link>
        ) : null}
        <div className="min-w-0">
          <div className="flex min-h-8 flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <h1 className="min-w-0 text-xl leading-7 font-semibold tracking-[-0.01em] wrap-anywhere">{title}</h1>
            {badges}
          </div>
          {meta ? <div className="mt-0.5 text-meta text-muted-foreground tabular-nums wrap-anywhere">{meta}</div> : null}
          {description ? <p className="mt-1 max-w-measure text-sm text-muted-foreground">{description}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}
