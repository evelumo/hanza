import type { Page } from '@playwright/test'
import { expect, mainNavigation, openCommandPalette, signUp, test } from '../src/fixtures'

/** A Product with a SKU no seed Offer has, so nothing is sent to the fake Channel. */
async function addTeapot(page: Page): Promise<string> {
  await page.goto('/products/new')
  await page.getByLabel('SKU', { exact: true }).fill('SHELL-TEAPOT')
  await page.getByLabel('Name', { exact: true }).fill('Enamel teapot')
  await page.getByRole('button', { name: 'Add product' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Enamel teapot' })).toBeVisible()
  return new URL(page.url()).pathname
}

test('the command palette opens from the Search button and the keyboard, goes to a page and hands a search to Products', async ({ page }) => {
  await signUp(page)
  await addTeapot(page)

  const palette = await openCommandPalette(page)
  const search = palette.getByRole('combobox')
  // Opened, it offers the actions that create something before the places the sidebar already lists.
  await expect(palette.getByRole('option').first()).toHaveText('Add product')
  for (const action of ['Add product', 'Add connection', 'Add product family', 'Add warehouse']) {
    await expect(palette.getByRole('option', { name: action, exact: true })).toBeInViewport()
  }
  await expect(palette.getByRole('option', { name: 'Settings: System', exact: true })).toBeAttached()

  // Plain "contains" matching: the destination first, then the action that creates one, and last the search that is always offered.
  await search.fill('wareh')
  await expect(palette.getByRole('option')).toHaveText(['Warehouses', 'Add warehouse', 'Search products for “wareh”'])
  // No Product is called that, and the palette says so instead of showing nothing.
  await expect(palette.getByRole('status')).toHaveText('No product has “wareh” in its name or SKU.')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 1, name: 'Warehouses' })).toBeVisible()
  await expect(palette).toBeHidden()

  await page.keyboard.press('ControlOrMeta+k')
  // Opened afresh: the text of the last visit is gone.
  await expect(search).toHaveValue('')
  await search.fill('teapot')
  await palette.getByRole('option', { name: 'Search products for “teapot”' }).click()
  await expect(page).toHaveURL(/\/products\?q=teapot$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Products' })).toBeVisible()
  await expect(page.getByRole('searchbox', { name: 'Search by SKU or name' })).toHaveValue('teapot')
  await expect(page.getByRole('link', { name: 'Enamel teapot', exact: true })).toBeVisible()

  // The same key closes it again.
  await page.keyboard.press('ControlOrMeta+k')
  await expect(palette).toBeVisible()
  await page.keyboard.press('ControlOrMeta+k')
  await expect(palette).toBeHidden()
})

test('the command palette finds a Product by its name or SKU while typing, and Enter opens it', async ({ page }) => {
  await signUp(page)
  const productPath = await addTeapot(page)
  await page.goto('/dashboard')

  const palette = await openCommandPalette(page)
  const search = palette.getByRole('combobox')
  const result = palette.getByRole('option', { name: /^Enamel teapot\s*SHELL-TEAPOT$/ })
  // By name: the Product itself, above the hand-off to the Products list.
  await search.fill('teapot')
  await expect(palette.getByRole('option')).toHaveText([/^Enamel teapot\s*SHELL-TEAPOT$/, 'Search products for “teapot”'])
  // No page or action is called that, so the direct hit is what Enter takes.
  await expect(result).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL((url) => url.pathname === productPath)
  await expect(page.getByRole('heading', { level: 1, name: 'Enamel teapot' })).toBeVisible()
  await expect(palette).toBeHidden()

  // By SKU, in any letter case, and with the mouse.
  await openCommandPalette(page)
  await search.fill('shell-tea')
  await result.click()
  await expect(page).toHaveURL((url) => url.pathname === productPath)

  // A text no Product has: the palette says so, and the search hand-off stays.
  await openCommandPalette(page)
  await search.fill('zzz-no-such')
  await expect(palette.getByRole('status')).toHaveText('No product has “zzz-no-such” in its name or SKU.')
  await expect(palette.getByRole('option')).toHaveText(['Search products for “zzz-no-such”'])
})

test('the sidebar marks the destination a page belongs to, and the breadcrumb leads back to its list', async ({ page }) => {
  await signUp(page)
  const nav = mainNavigation(page)
  const item = (name: string) => nav.getByRole('link', { name, exact: true })
  await expect(item('Dashboard')).toHaveAttribute('aria-current', 'page')

  await item('Products').click()
  await expect(page.getByRole('heading', { level: 1, name: 'Products' })).toBeVisible()
  await expect(item('Products')).toHaveAttribute('aria-current', 'page')
  await expect(item('Dashboard')).not.toHaveAttribute('aria-current')

  // A page below the list still belongs to it, and the breadcrumb is the way back.
  await page.getByRole('link', { name: 'Add product' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Add product' })).toBeVisible()
  await expect(item('Products')).toHaveAttribute('aria-current', 'page')
  const breadcrumb = page.getByRole('banner').getByRole('navigation', { name: 'Breadcrumb' })
  await expect(breadcrumb.getByRole('listitem')).toHaveText(['Catalogue', 'Products', 'New'])
  await breadcrumb.getByRole('link', { name: 'Products' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Products' })).toBeVisible()
  await expect(page).toHaveURL(/\/products$/)

  // Offers live under /products/offers and are a destination of their own: the longest match wins, and the
  // page has no "back" to Products.
  await item('Offers').click()
  await expect(page.getByRole('heading', { level: 1, name: 'Offers that need attention' })).toBeVisible()
  await expect(item('Offers')).toHaveAttribute('aria-current', 'page')
  await expect(item('Products')).not.toHaveAttribute('aria-current')
  await expect(page.getByRole('main').getByRole('link', { name: /^Back to/ })).toHaveCount(0)
})
