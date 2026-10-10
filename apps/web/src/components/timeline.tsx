import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { TextLink } from './text-link'

/**
 * Events in time order, for histories and activity. It follows the width it is given, not the window's: in a
 * narrow place (an aside, a phone) every event is a stack of title, detail and time; from 28rem on the time
 * sits at the right of the title's line.
 */
export function Timeline({ className, children }: { className?: string; children: ReactNode }) {
  return <ol className={cn('@container px-4 py-3.5', className)}>{children}</ol>
}

/**
 * `at` is the moment, `atLabel` the same moment as the page's formatter prints it; children are the detail line.
 * `link` leads to what the event is about and closes the detail line: its text names the place ("Order 1042"),
 * so a list of events never holds two links of one name to different places.
 */
export function TimelineItem({
  title,
  at,
  atLabel,
  link,
  children,
}: {
  title: ReactNode
  at: Date
  atLabel: string
  link?: { href: string; label: ReactNode }
  children?: ReactNode
}) {
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      {/* The line to the next event; the last event has none. */}
      <span aria-hidden="true" className="absolute top-4 bottom-0 left-[3.5px] w-px bg-border [li:last-child>&]:hidden" />
      <span aria-hidden="true" className="relative mt-1.5 size-2 shrink-0 rounded-full bg-border-strong" />
      <div className="min-w-0 flex-1 @md:flex @md:items-baseline @md:justify-between @md:gap-x-4">
        <div className="min-w-0">
          <p className="text-sm break-words">{title}</p>
          {children || link ? (
            <p className="text-meta break-words text-muted-foreground">
              {children}
              {children && link ? <span aria-hidden="true">{'\u00a0· '}</span> : null}
              {link ? (
                <TextLink href={link.href} className="font-normal">
                  {link.label}
                </TextLink>
              ) : null}
            </p>
          ) : null}
        </div>
        <time dateTime={at.toISOString()} className="mt-0.5 block text-xs whitespace-nowrap text-muted-foreground tabular-nums @md:mt-0">
          {atLabel}
        </time>
      </div>
    </li>
  )
}
