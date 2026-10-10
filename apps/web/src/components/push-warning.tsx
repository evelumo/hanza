import { TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** A sentence in a table cell saying that something (a stock, a price) does not reach the Channel. */
export function PushWarning({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cn('flex max-w-xs items-start gap-1 text-meta font-medium text-warning', className)}>
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </span>
  )
}
