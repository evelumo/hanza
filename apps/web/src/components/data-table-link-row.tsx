'use client'

import { useRouter } from 'next/navigation'
import type { ComponentProps } from 'react'
import { TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'

const interactive = 'a, button, input, select, textarea, label, summary, [role="button"], [role="checkbox"]'

/**
 * A row that opens `href` when clicked anywhere on it. Only a convenience for the mouse: the row must still
 * contain a real link to the same place (the first cell's `TextLink`), which is what the keyboard and screen
 * readers use. Clicks on controls inside the row, and clicks that end a text selection, are left alone.
 */
export function DataTableLinkRow({ href, className, onClick, ...props }: ComponentProps<'tr'> & { href: string }) {
  const router = useRouter()
  return (
    <TableRow
      {...props}
      className={cn('cursor-pointer hover:bg-muted/60', className)}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented || event.button !== 0) return
        if ((event.target as HTMLElement).closest(interactive)) return
        if (window.getSelection()?.toString()) return
        if (event.metaKey || event.ctrlKey) window.open(href, '_blank', 'noopener')
        else router.push(href)
      }}
    />
  )
}
