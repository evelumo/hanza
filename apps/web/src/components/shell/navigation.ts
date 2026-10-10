import {
  Boxes,
  Cable,
  LayoutDashboard,
  Package,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Tags,
  Warehouse,
  type LucideIcon,
} from 'lucide-react'
import type { MessageKey } from '@/i18n/types'

export interface NavItem {
  href: string
  label: MessageKey
  icon: LucideIcon
  /** The path prefix that marks the item as current, when it differs from `href`. */
  section?: string
  /** The pages below a destination that has several (Settings); the first is the one `href` opens. */
  pages?: NavPage[]
  /** What the sidebar counts beside the item, when there is something to count. */
  count?: NavCount
}

export interface NavPage {
  href: string
  label: MessageKey
}

/** `orders`: Orders that need attention. `offers`: Offers without a Product. */
export type NavCount = 'orders' | 'offers'

/** The pages of Settings: its sub-navigation, the breadcrumbs and the command palette all list these. */
export const settingsPages: NavPage[] = [
  { href: '/settings/order-statuses', label: 'shell.breadcrumb.orderStatuses' },
  { href: '/settings/system', label: 'shell.breadcrumb.system' },
]

export interface NavGroup {
  /** No label: the item stands alone above the groups. */
  label?: MessageKey
  items: NavItem[]
}

/** The panel's destinations, grouped by the job they serve. The sidebar, the breadcrumbs and the command palette all read this. */
export const navigation: NavGroup[] = [
  { items: [{ href: '/dashboard', label: 'nav.dashboard', icon: LayoutDashboard }] },
  { label: 'shell.groups.sales', items: [{ href: '/orders', label: 'nav.orders', icon: ShoppingCart, count: 'orders' }] },
  {
    label: 'shell.groups.catalogue',
    items: [
      { href: '/products', label: 'nav.products', icon: Package },
      { href: '/products/offers', label: 'nav.offers', icon: Tags, count: 'offers' },
      { href: '/families', label: 'nav.families', icon: Boxes },
    ],
  },
  { label: 'shell.groups.stock', items: [{ href: '/warehouses', label: 'nav.warehouses', icon: Warehouse }] },
  { label: 'shell.groups.channels', items: [{ href: '/connections', label: 'nav.connections', icon: Cable }] },
  {
    label: 'shell.groups.organization',
    items: [
      { href: '/privacy', label: 'nav.privacy', icon: ShieldCheck },
      { href: '/settings/order-statuses', label: 'nav.settings', icon: Settings, section: '/settings', pages: settingsPages },
    ],
  },
]

const sectionOf = (item: NavItem) => item.section ?? item.href

/**
 * The destination a path belongs to: the one with the longest matching prefix, so `/products/offers/…` is
 * Offers and not Products.
 */
export function activeNavItem(pathname: string): { group: NavGroup; item: NavItem } | null {
  let best: { group: NavGroup; item: NavItem } | null = null
  for (const group of navigation) {
    for (const item of group.items) {
      const section = sectionOf(item)
      if (pathname !== section && !pathname.startsWith(`${section}/`)) continue
      if (!best || section.length > sectionOf(best.item).length) best = { group, item }
    }
  }
  return best
}

// Path segments below a destination that have a name; any other segment is an id and is not shown.
const segmentLabels: Record<string, MessageKey> = {
  new: 'shell.breadcrumb.new',
  'sign-in': 'shell.breadcrumb.signIn',
  'order-statuses': 'shell.breadcrumb.orderStatuses',
  system: 'shell.breadcrumb.system',
}

export interface Crumb {
  label: MessageKey
  /** Absent for a group name (not a page), for the current page, and for a destination whose page is the current one. */
  href?: string
  current: boolean
}

/**
 * The trail for a path: group, destination, then the named segments below it. An id (an Order, a Product) is not
 * a crumb: from its page the destination crumb is the link back to the list.
 */
export function breadcrumbsFor(pathname: string): Crumb[] {
  const active = activeNavItem(pathname)
  if (!active) return []
  const { group, item } = active
  const section = sectionOf(item)
  const named = pathname
    .slice(section.length)
    .split('/')
    .flatMap((segment) => (Object.hasOwn(segmentLabels, segment) ? [segmentLabels[segment] as MessageKey] : []))
  const crumbs: Crumb[] = []
  if (group.label) crumbs.push({ label: group.label, current: false })
  crumbs.push({
    label: item.label,
    href: pathname === section || pathname === item.href ? undefined : item.href,
    current: pathname === section && named.length === 0,
  })
  named.forEach((label, index) => crumbs.push({ label, current: index === named.length - 1 }))
  return crumbs
}
