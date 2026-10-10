import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * A SKU, an external id, a code: the only text set in the monospace stack (an Order number is not: people read
 * it out and type it, so it is set in the interface's own face, see `orderNumberClass`). It stays on one line,
 * as a table column wants; `wrap` lets a long one break anywhere, for a place as narrow as an aside or a phone.
 */
export function Identifier({ wrap = false, children, className }: { wrap?: boolean; children: ReactNode; className?: string }) {
  return <span data-slot="identifier" className={cn('font-mono text-meta', wrap ? 'break-all' : 'whitespace-nowrap', className)}>{children}</span>
}
