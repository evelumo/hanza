import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** The root of every panel page: one column of `PageHeader`, then sections, at one rhythm. */
export function Page({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('@container flex flex-col gap-5', className)}>{children}</div>
}

/**
 * The body of a detail page. Wide: the main column beside a narrower `aside`, with `after` (long logs such as
 * a history) continuing the main column. Narrow: one column in reading order, main, aside, after. It follows
 * the width of the page, not of the window, so it also holds when the sidebar is open.
 */
export function PageColumns({ aside, after, children }: { aside: ReactNode; after?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-5 @5xl:grid-cols-[minmax(0,1fr)_21rem] @5xl:grid-rows-[auto_1fr]">
      <div className="flex min-w-0 flex-col gap-5">{children}</div>
      <div className="flex min-w-0 flex-col gap-5 @5xl:row-span-2">{aside}</div>
      {after ? <div className="flex min-w-0 flex-col gap-5 @5xl:col-start-1">{after}</div> : null}
    </div>
  )
}
