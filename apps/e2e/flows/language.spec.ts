import { expect, mainNavigation, openUserMenu, signUp, test } from '../src/fixtures'

test('the panel switches between English and Polish and remembers the choice', async ({ page }) => {
  const account = await signUp(page)
  let menu = await openUserMenu(page, account)
  await expect(menu.getByRole('menuitemradio', { name: 'English' })).toBeChecked()

  await menu.getByRole('menuitemradio', { name: 'Polski' }).click()
  const polishNav = page.getByRole('navigation', { name: 'Główna nawigacja' })
  await expect(polishNav.getByRole('link', { name: 'Zamówienia' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: 'Pulpit' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'pl')

  // The choice is a cookie, so it survives a new page load and holds on every page.
  await polishNav.getByRole('link', { name: 'Zamówienia' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Zamówienia' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Zamówienia' })).toBeVisible()
  menu = await openUserMenu(page, account)
  await expect(menu.getByRole('menuitemradio', { name: 'Polski' })).toBeChecked()

  await menu.getByRole('menuitemradio', { name: 'English' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible()
  await expect(mainNavigation(page).getByRole('link', { name: 'Orders' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
})
