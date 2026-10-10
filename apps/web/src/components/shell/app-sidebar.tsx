'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar'
import { useT } from '@/i18n/use-t'
import { BrandMark } from './brand-mark'
import { activeNavItem, navigation, type NavCount } from './navigation'
import { UserMenu } from './user-menu'

/** Past this a count stops being read and only says "many". */
const COUNT_CAP = 99

export function AppSidebar({
  organizationName,
  user,
  counts,
}: {
  organizationName: string
  user: { name: string; email: string }
  /** What waits for a person behind an item; an item whose count is zero shows nothing. */
  counts: Record<NavCount, number>
}) {
  const t = useT()
  const pathname = usePathname()
  const { setOpenMobile } = useSidebar()
  const active = activeNavItem(pathname)?.item
  return (
    <Sidebar collapsible="icon" mobileTitle={t('shell.sidebar.mobileTitle')} mobileDescription={t('shell.sidebar.mobileDescription')}>
      <SidebarHeader>
        <div className="flex h-10 items-center gap-2.5 px-1">
          <BrandMark />
          <div className="grid min-w-0 leading-tight group-data-[collapsible=icon]:hidden">
            <span className="text-sm font-semibold">Hanza</span>
            <span className="truncate text-xs text-muted-foreground">{organizationName}</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label={t('nav.label')} className="flex flex-col">
          {navigation.map((group, index) => (
            <SidebarGroup key={group.label ?? index} className="py-1.5">
              {group.label ? <SidebarGroupLabel id={`nav-group-${index}`}>{t(group.label)}</SidebarGroupLabel> : null}
              <SidebarMenu aria-labelledby={group.label ? `nav-group-${index}` : undefined}>
                {group.items.map((item) => {
                  const count = item.count ? counts[item.count] : 0
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton asChild isActive={item === active} tooltip={t(item.label)} className={count > 0 ? 'pr-9' : undefined}>
                        {/* On a small screen the sidebar is a sheet over the page: following a link closes it. */}
                        <Link
                          href={item.href}
                          aria-current={item === active ? 'page' : undefined}
                          // The count is part of the link's name, in words; the number beside it is its picture.
                          aria-label={count > 0 && item.count ? t(`shell.count.${item.count}`, { count }) : undefined}
                          onClick={() => setOpenMobile(false)}
                        >
                          <item.icon aria-hidden="true" />
                          <span className="truncate">{t(item.label)}</span>
                        </Link>
                      </SidebarMenuButton>
                      {count > 0 ? (
                        <>
                          <SidebarMenuBadge aria-hidden="true" className="rounded-full bg-foreground/8 px-1.5">
                            {count > COUNT_CAP ? `${COUNT_CAP}+` : count}
                          </SidebarMenuBadge>
                          {/* Collapsed to icons there is no room for a number: a dot on the icon says that something waits. */}
                          <span
                            aria-hidden="true"
                            className="pointer-events-none absolute top-1 right-1 hidden size-1.5 rounded-full bg-foreground group-data-[collapsible=icon]:block"
                          />
                        </>
                      ) : null}
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroup>
          ))}
        </nav>
      </SidebarContent>
      <SidebarFooter>
        <UserMenu name={user.name} email={user.email} />
      </SidebarFooter>
      <SidebarRail label={t('shell.sidebar.toggle')} />
    </Sidebar>
  )
}
