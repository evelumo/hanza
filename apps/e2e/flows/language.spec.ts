import { expect, signUp, test } from '../src/fixtures'

test('the panel switches between English and Polish and remembers the choice', async ({ page }) => {
  await signUp(page)
  const english = page.getByRole('group', { name: 'Language' })
  await expect(english.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true')

  await english.getByRole('button', { name: 'Polski' }).click()
  const polishNav = page.getByRole('navigation', { name: 'Główna nawigacja' })
  await expect(polishNav.getByRole('link', { name: 'Zamówienia' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: 'Pulpit' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'pl')

  // The choice is a cookie, so it survives a new page load and holds on every page.
  await polishNav.getByRole('link', { name: 'Zamówienia' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Zamówienia' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('group', { name: 'Język' }).getByRole('button', { name: 'Polski' })).toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('group', { name: 'Język' }).getByRole('button', { name: 'English' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Orders' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
})
