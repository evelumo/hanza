import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Term and value pairs, for detail pages and their asides. `stacked` puts the value under its term (narrow
 * columns); `inline` puts them side by side, one pair per row.
 */
export function DescriptionList({
  layout = 'stacked',
  className,
  children,
}: {
  layout?: 'stacked' | 'inline'
  className?: string
  children: ReactNode
}) {
  return (
    <dl data-layout={layout} className={cn('group/dl grid', layout === 'stacked' ? 'gap-3.5' : 'divide-y divide-border', className)}>
      {children}
    </dl>
  )
}

export function DescriptionItem({ term, className, children }: { term: string; className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        'min-w-0 group-data-[layout=inline]/dl:grid group-data-[layout=inline]/dl:grid-cols-[minmax(6rem,2fr)_3fr] group-data-[layout=inline]/dl:gap-3 group-data-[layout=inline]/dl:py-2',
        className,
      )}
    >
      <dt className="text-meta text-muted-foreground">{term}</dt>
      <dd className="text-sm break-words group-data-[layout=stacked]/dl:mt-0.5">{children}</dd>
    </div>
  )
}
