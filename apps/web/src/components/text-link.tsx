import Link from 'next/link'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/** For an <a> that is not a route (an external page); routes use `TextLink`. */
export const textLinkClass = 'rounded-sm font-medium text-link hover:underline'

/**
 * An Order number wherever it stands: the interface's face with proportional figures. Tabular figures would
 * also widen its hyphens ("fake - order - 1"), and Order numbers are read, not summed down a column.
 */
export const orderNumberClass = 'normal-nums'

/**
 * A link inside content: a table cell, a sentence, a description list. Buttons that navigate use `buttonClass`.
 * `mono` is for a link whose text is an identifier (a SKU, an external id); an Order number takes
 * `orderNumberClass` instead.
 */
export function TextLink({ mono = false, className, ...props }: ComponentProps<typeof Link> & { mono?: boolean }) {
  return <Link {...props} data-slot={mono ? 'identifier' : undefined} className={cn(textLinkClass, mono && 'font-mono text-meta whitespace-nowrap', className)} />
}
