/*
 * The look of a row of tabs and of one tab. In a module of its own (not tabs.tsx, a client module) so
 * server components such as `FilterTabs` and the language switcher can draw links and buttons the same way.
 */
export const tabsListClass = 'flex flex-wrap items-center gap-1'

export const tabClass =
  'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-meta font-medium whitespace-nowrap text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:pointer-events-none disabled:opacity-50'

export const tabActiveClass = 'bg-foreground/8 text-foreground hover:bg-foreground/8'
