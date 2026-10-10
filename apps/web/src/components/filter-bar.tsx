import { Check, Search, X } from 'lucide-react'
import Link from 'next/link'
import { useId, type ComponentProps, type ReactNode } from 'react'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { tabActiveClass, tabClass, tabsListClass } from '@/components/ui/tab-styles'
import { useT } from '@/i18n/use-t'
import { cn } from '@/lib/utils'
import { buttonClass } from './button-class'

/*
 * Filters of a list page live in the URL, so they work as plain links and GET forms, survive a reload and can
 * be shared. Build each href with `pageHref(basePath, { ...currentParams, key: value }, 1)` from `lib/pagination`.
 */

/** The strip of filters at the top of a list's `Panel`. */
export function FilterBar({ label, className, children }: { label?: string; className?: string; children: ReactNode }) {
  const t = useT()
  return (
    <div
      role="group"
      aria-label={label ?? t('common.filters')}
      className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-3 py-2', className)}
    >
      {children}
    </div>
  )
}

/** Mutually exclusive views of a list (All, New, Processing, …) as links; the active one is the current page. */
export function FilterTabs({ label, tabs }: { label: string; tabs: Array<{ href: string; label: string; active: boolean }> }) {
  return (
    <nav aria-label={label}>
      <ul className={tabsListClass}>
        {tabs.map((tab) => (
          <li key={tab.href}>
            <Link href={tab.href} aria-current={tab.active ? 'page' : undefined} className={cn(tabClass, tab.active && tabActiveClass)}>
              {tab.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}

/** A filter that is on or off. A link: `href` is the list with the filter flipped. On shows a tick, not only a fill. */
export function FilterChip({ href, active, children }: { href: string; active: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-meta font-medium whitespace-nowrap transition-colors',
        active
          ? 'border-foreground/25 bg-foreground/8 pl-2 text-foreground hover:bg-foreground/12'
          : 'border-dashed border-border-strong text-muted-foreground hover:border-solid hover:bg-foreground/5 hover:text-foreground',
      )}
    >
      {active ? <Check className="size-3.5" aria-hidden="true" /> : null}
      {children}
    </Link>
  )
}

/** A GET form for filters that need a control. `params` are the other filters to keep, sent as hidden fields. */
export function FilterForm({
  action,
  params = {},
  className,
  children,
  ...form
}: { action: string; params?: Record<string, string | undefined> } & Omit<ComponentProps<'form'>, 'action' | 'method'>) {
  return (
    <form {...form} method="get" action={action} className={cn('flex flex-wrap items-center gap-2', className)}>
      {Object.entries(params).map(([name, value]) => (value ? <input key={name} type="hidden" name={name} value={value} /> : null))}
      {children}
    </form>
  )
}

/**
 * A native select inside a `FilterForm`; the label is visible, small, in front of it. `defaultValue` is the
 * filter that is applied now.
 */
export function FilterSelect({ label, className, children, ...select }: { label: string } & Omit<ComponentProps<'select'>, 'size'>) {
  const generatedId = useId()
  const id = select.id ?? generatedId
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-meta font-medium text-muted-foreground">
        {label}
      </label>
      {/* The other filters are links, and following one keeps this element on the page: React leaves the choice of a
          mounted select alone when its default changes, so without the key it would go on showing a filter that a tab
          or "Clear filters" has just dropped. */}
      <NativeSelect key={String(select.defaultValue ?? '')} {...select} id={id} size="sm" className={cn('w-auto max-w-56', className)}>
        {children}
      </NativeSelect>
    </div>
  )
}

/** A search box inside a `FilterForm` (give the form `role="search"`); Enter submits. The label is its only name. */
export function SearchField({ label, className, ...input }: { label: string } & Omit<ComponentProps<'input'>, 'type'>) {
  const generatedId = useId()
  const id = input.id ?? generatedId
  return (
    <div className={cn('relative w-full max-w-xs', className)}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input name="q" {...input} id={id} type="search" className="h-7 pl-8 md:text-meta" />
    </div>
  )
}

/** Shown only while a filter is active; `href` is the bare list. */
export function FilterClear({ href, children }: { href: string; children?: ReactNode }) {
  const t = useT()
  return (
    <Link href={href} className={cn(buttonClass('ghost', 'sm'), 'text-muted-foreground hover:text-foreground')}>
      <X aria-hidden="true" />
      {children ?? t('common.clearFilters')}
    </Link>
  )
}
