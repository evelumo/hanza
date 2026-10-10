import * as React from 'react'
import { ChevronRight } from 'lucide-react'
import { Slot } from 'radix-ui'
import { cn } from '@/lib/utils'

/** `aria-label` is required: the trail's name is translated by the caller. */
function Breadcrumb({ ...props }: React.ComponentProps<'nav'> & { 'aria-label': string }) {
  return <nav data-slot="breadcrumb" {...props} />
}

function BreadcrumbList({ className, ...props }: React.ComponentProps<'ol'>) {
  return (
    <ol data-slot="breadcrumb-list" className={cn('flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground', className)} {...props} />
  )
}

function BreadcrumbItem({ className, ...props }: React.ComponentProps<'li'>) {
  return <li data-slot="breadcrumb-item" className={cn('inline-flex min-w-0 items-center gap-1.5', className)} {...props} />
}

function BreadcrumbLink({
  asChild,
  className,
  ...props
}: React.ComponentProps<'a'> & {
  asChild?: boolean
}) {
  const Comp = asChild ? Slot.Root : 'a'

  return <Comp data-slot="breadcrumb-link" className={cn('truncate rounded-sm transition-colors hover:text-foreground', className)} {...props} />
}

// Not a link: the page a person is on is plain text marked as current, so no second link carries a page's name.
function BreadcrumbPage({ className, ...props }: React.ComponentProps<'span'>) {
  return <span data-slot="breadcrumb-page" aria-current="page" className={cn('truncate font-medium text-foreground', className)} {...props} />
}

function BreadcrumbSeparator({ children, className, ...props }: React.ComponentProps<'li'>) {
  return (
    <li data-slot="breadcrumb-separator" role="presentation" aria-hidden="true" className={cn('[&>svg]:size-3.5', className)} {...props}>
      {children ?? <ChevronRight />}
    </li>
  )
}

export { Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbLink, BreadcrumbPage, BreadcrumbSeparator }
