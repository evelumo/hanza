import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * What a list or a section shows when it has nothing: with a `title`, a centred block whose text (the children)
 * says what to do next and whose `action` does it; with children alone, one quiet line.
 */
export function EmptyState({
  icon: Icon,
  title,
  action,
  className,
  children,
}: {
  icon?: LucideIcon
  title?: string
  action?: ReactNode
  className?: string
  children?: ReactNode
}) {
  if (!title) return <p className={cn('px-4 py-6 text-sm text-muted-foreground', className)}>{children}</p>
  return (
    <div className={cn('flex flex-col items-center px-4 py-12 text-center', className)}>
      {Icon ? (
        <span className="mb-3 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon className="size-5" aria-hidden="true" />
        </span>
      ) : null}
      <p className="text-sm font-semibold">{title}</p>
      {children ? <p className="mt-1 max-w-sm text-sm text-muted-foreground">{children}</p> : null}
      {action ? <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  )
}
