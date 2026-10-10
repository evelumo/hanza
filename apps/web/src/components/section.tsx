import { useId, type ReactNode } from 'react'
import { cardSurfaceClass } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export { EmptyState } from './empty-state'

/**
 * A card that is a region named by its heading, so assistive technology (and tests) can find e.g. the "Stock"
 * section. Its children sit flush against the card's edges, which is what a table or a list wants; wrap
 * anything else in `SectionContent`.
 */
export function Section({
  title,
  description,
  actions,
  id,
  className,
  children,
}: {
  title: string
  description?: string
  actions?: ReactNode
  /** For a link on the same page that points at this section (`href="#lines"`). */
  id?: string
  className?: string
  children: ReactNode
}) {
  const headingId = useId()
  return (
    // The offset keeps a section that a link jumps to clear of the sticky top bar.
    <section id={id} aria-labelledby={headingId} className={cn(cardSurfaceClass, 'scroll-mt-16 overflow-hidden', className)}>
      <div className="border-b border-border px-4 py-3">
        <div className="flex min-h-[1.375rem] flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h2 id={headingId} className="text-sm leading-5 font-semibold">
            {title}
          </h2>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
        {description ? <p className="mt-1 max-w-measure text-meta text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  )
}

export function SectionContent({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('p-4', className)}>{children}</div>
}

/** A card without a heading of its own: the table of a list page, which the page's <h1> already names. */
export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn(cardSurfaceClass, 'overflow-hidden', className)}>{children}</div>
}
