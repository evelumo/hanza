import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * A whole page reduced to one message (not found, failed to load): what happened, in the page's <h1>, and the
 * way out as its children. For a list or a section with nothing in it use `EmptyState`.
 */
export function PageState({
  icon: Icon,
  critical = false,
  title,
  description,
  children,
}: {
  icon: LucideIcon
  critical?: boolean
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col items-center px-4 py-12 text-center">
      <span
        className={cn(
          'mb-3 flex size-10 items-center justify-center rounded-full',
          critical ? 'bg-critical-subtle text-critical' : 'bg-muted text-muted-foreground',
        )}
      >
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <h1 className="text-xl leading-7 font-semibold tracking-[-0.01em]">{title}</h1>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">{children}</div>
    </div>
  )
}
