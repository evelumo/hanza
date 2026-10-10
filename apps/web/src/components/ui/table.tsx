import * as React from 'react'
import { cn } from '@/lib/utils'

/*
 * The roles are spelled out because a narrow container lays the rows out as stacked blocks (globals.css): a
 * table part with another `display` keeps its meaning in every browser only when its role is explicit.
 * The cells' own box (height, padding, alignment) is set in globals.css too, where the narrow layout can change it.
 */

function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table role="table" data-slot="table" className={cn('w-full caption-bottom text-sm', className)} {...props} />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead role="rowgroup" data-slot="table-header" className={cn('bg-muted/60 [&_tr]:border-b', className)} {...props} />
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return <tbody role="rowgroup" data-slot="table-body" className={cn('[&_tr:last-child]:border-0', className)} {...props} />
}

function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
  return (
    <tfoot role="rowgroup" data-slot="table-footer" className={cn('border-t bg-muted/60 font-medium [&>tr]:last:border-b-0', className)} {...props} />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return <tr role="row" data-slot="table-row" className={cn('border-b border-border transition-colors', className)} {...props} />
}

function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      role="columnheader"
      data-slot="table-head"
      className={cn('h-9 px-4 text-left align-middle text-meta font-medium whitespace-nowrap text-muted-foreground', className)}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return <td role="cell" data-slot="table-cell" className={className} {...props} />
}

function TableCaption({ className, ...props }: React.ComponentProps<'caption'>) {
  return <caption data-slot="table-caption" className={cn('mt-3 text-meta text-muted-foreground', className)} {...props} />
}

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption }
