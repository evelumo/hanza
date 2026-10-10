import { describe, expect, it } from 'vitest'
import { activeNavItem, breadcrumbsFor, navigation, settingsPages } from './navigation'

const active = (pathname: string) => activeNavItem(pathname)?.item.href

describe('activeNavItem', () => {
  it('marks a destination on its own page and on the pages below it', () => {
    expect(active('/orders')).toBe('/orders')
    expect(active('/orders/abc')).toBe('/orders')
    expect(active('/connections/sign-in/abc')).toBe('/connections')
  })

  it('prefers the longest match, so Products is not current on Offers', () => {
    expect(active('/products')).toBe('/products')
    expect(active('/products/new')).toBe('/products')
    expect(active('/products/offers')).toBe('/products/offers')
    expect(active('/products/offers/abc')).toBe('/products/offers')
  })

  it('marks Settings for every settings page', () => {
    expect(active('/settings')).toBe('/settings/order-statuses')
    expect(active('/settings/order-statuses')).toBe('/settings/order-statuses')
    expect(active('/settings/system')).toBe('/settings/order-statuses')
    expect(active('/settings/anything-else')).toBe('/settings/order-statuses')
  })

  it('does not match a path that merely starts with the same letters', () => {
    expect(active('/orders-archive')).toBeUndefined()
    expect(active('/login')).toBeUndefined()
  })

  it('lists every destination once', () => {
    const hrefs = navigation.flatMap((group) => group.items.map((item) => item.href))
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })
})

describe('breadcrumbsFor', () => {
  it('ends on the destination, as the current page, on a list', () => {
    expect(breadcrumbsFor('/orders')).toEqual([
      { label: 'shell.groups.sales', current: false },
      { label: 'nav.orders', href: undefined, current: true },
    ])
  })

  it('has no group for the dashboard', () => {
    expect(breadcrumbsFor('/dashboard')).toEqual([{ label: 'nav.dashboard', href: undefined, current: true }])
  })

  it('does not show an id: the destination links back to the list', () => {
    expect(breadcrumbsFor('/orders/abc')).toEqual([
      { label: 'shell.groups.sales', current: false },
      { label: 'nav.orders', href: '/orders', current: false },
    ])
    expect(breadcrumbsFor('/products/offers/abc').at(-1)).toEqual({ label: 'nav.offers', href: '/products/offers', current: false })
  })

  it('names the static pages below a destination', () => {
    expect(breadcrumbsFor('/products/new').slice(1)).toEqual([
      { label: 'nav.products', href: '/products', current: false },
      { label: 'shell.breadcrumb.new', current: true },
    ])
    expect(breadcrumbsFor('/connections/sign-in/abc').slice(1)).toEqual([
      { label: 'nav.connections', href: '/connections', current: false },
      { label: 'shell.breadcrumb.signIn', current: true },
    ])
  })

  it('does not link Settings to the page it opens on', () => {
    expect(breadcrumbsFor('/settings/order-statuses')).toEqual([
      { label: 'shell.groups.organization', current: false },
      { label: 'nav.settings', href: undefined, current: false },
      { label: 'shell.breadcrumb.orderStatuses', current: true },
    ])
  })

  it('names every page of Settings', () => {
    expect(breadcrumbsFor('/settings/system')).toEqual([
      { label: 'shell.groups.organization', current: false },
      { label: 'nav.settings', href: '/settings/order-statuses', current: false },
      { label: 'shell.breadcrumb.system', current: true },
    ])
    for (const page of settingsPages) expect(breadcrumbsFor(page.href).at(-1)).toEqual({ label: page.label, current: true })
  })

  it('is empty outside the panel', () => {
    expect(breadcrumbsFor('/login')).toEqual([])
  })
})
