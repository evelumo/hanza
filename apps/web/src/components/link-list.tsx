import { ChevronRight } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * A list whose rows are whole-row links to the place where their subject is handled: the dashboard's lists, a
 * choice among connectors. Put it straight into a `Section` or a `Panel`. A row that leads nowhere is a plain
 * `<li>` among them.
 */
export function LinkList({ ordered = false, children }: { ordered?: boolean; children: ReactNode }) {
  const List = ordered ? 'ol' : 'ul'
  return <List className="divide-y divide-border">{children}</List>
}

/**
 * `leading` is an icon beside the first line; `trailing` sits before the chevron (a count, a badge). `inline`
 * puts the detail beside the title while both fit and under it when they do not.
 */
export function LinkRow({
  href,
  leading,
  title,
  detail,
  trailing,
  inline = false,
  className,
}: {
  href: string
  leading?: ReactNode
  title: ReactNode
  detail?: ReactNode
  trailing?: ReactNode
  inline?: boolean
  className?: string
}) {
  return (
    <li>
      <Link
        href={href}
        className={cn(
          // The ring is drawn inside the row, where the card's clipped edge cannot cut it off.
          'flex min-h-11 items-center gap-3 px-4 py-3 -outline-offset-2 transition-colors hover:bg-muted/60 [li:last-child>&]:rounded-b-lg',
          className,
        )}
      >
        {leading ? <span className="mt-0.5 flex shrink-0 self-start">{leading}</span> : null}
        <span className={cn('min-w-0 flex-1', inline && 'flex flex-wrap items-baseline gap-x-3')}>
          <span className="block min-w-0 text-sm font-medium break-words">{title}</span>
          {detail ? <span className="block text-meta text-muted-foreground">{detail}</span> : null}
        </span>
        {trailing}
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Link>
    </li>
  )
}

/** A count at the end of a row, already formatted; a zero is quiet, so the rows that hold something stand out. */
export function RowCount({ value, children }: { value: number; children: ReactNode }) {
  return <span className={cn('shrink-0 text-sm tabular-nums', value === 0 ? 'text-muted-foreground' : 'font-medium')}>{children}</span>
}
