import { expect, mainNavigation, openCommandPalette, reloadUntil, signUp, test } from '../src/fixtures'

test('Settings has a System page whose test job goes through the queue and the worker', async ({ page }) => {
  await signUp(page)
  const settings = mainNavigation(page).getByRole('link', { name: 'Settings', exact: true })
  await settings.click()
  await expect(page.getByRole('heading', { level: 1, name: 'Order statuses' })).toBeVisible()

  // Both pages of Settings share one sub-navigation, and the sidebar's item stays current on both.
  const pages = page.getByRole('main').getByRole('navigation', { name: 'Settings' })
  await expect(pages.getByRole('link')).toHaveText(['Order statuses', 'System'])
  await expect(pages.getByRole('link', { name: 'Order statuses' })).toHaveAttribute('aria-current', 'page')
  await pages.getByRole('link', { name: 'System' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'System' })).toBeVisible()
  await expect(page).toHaveURL(/\/settings\/system$/)
  await expect(pages.getByRole('link', { name: 'System' })).toHaveAttribute('aria-current', 'page')
  await expect(pages.getByRole('link', { name: 'Order statuses' })).not.toHaveAttribute('aria-current')
  await expect(settings).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('banner').getByRole('navigation', { name: 'Breadcrumb' }).getByRole('listitem')).toHaveText(['Organization', 'Settings', 'System'])

  // The job is taken by the queue, run by the worker, and leaves its Event here.
  const queue = page.getByRole('region', { name: 'Queue and worker' })
  await expect(queue).toContainText('No test job has run yet.')
  await queue.getByRole('button', { name: 'Send test job' }).click()
  await reloadUntil(page, '/settings/system', async () => {
    await expect(queue.getByRole('listitem')).toHaveText([/^Test job/], { timeout: 1_000 })
  })
  // It shows among the organization's recent events as well, which the dashboard lists.
  await page.goto('/dashboard')
  await expect(page.getByRole('region', { name: 'Recent events' }).getByRole('listitem').filter({ hasText: 'Test job' })).toHaveCount(1)

  // The command palette knows the page too.
  const palette = await openCommandPalette(page)
  await palette.getByRole('combobox').fill('system')
  await palette.getByRole('option', { name: 'Settings: System', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'System' })).toBeVisible()
})
