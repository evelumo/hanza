'use client'

import { Separator } from '@/components/ui/separator'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { useT } from '@/i18n/use-t'
import { Breadcrumbs } from './breadcrumbs'
import { CommandPalette } from './command-palette'

/** The page's banner: where a person is (breadcrumbs) and the way to anywhere else (search). */
export function TopBar() {
  const t = useT()
  return (
    <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-3 sm:px-4">
      <SidebarTrigger label={t('shell.sidebar.toggle')} className="-ml-1 size-8 text-muted-foreground" />
      <Separator orientation="vertical" className="mr-1 h-4" />
      <div className="min-w-0 flex-1">
        <Breadcrumbs />
      </div>
      <CommandPalette />
    </header>
  )
}
