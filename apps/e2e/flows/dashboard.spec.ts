import { addFakeConnection, expect, mainNavigation, navLink, reloadUntil, signUp, test, waitForSeedOrders } from '../src/fixtures'

test('a new organization sees where to start and that nothing is waiting', async ({ page }) => {
  await signUp(page)
  const setup = page.getByRole('region', { name: 'Getting started' })
  await expect(setup).toContainText('0 of 3 done')
  await expect(setup.getByRole('listitem')).toHaveText([/^Connect a channel/, /^Create products for your offers/, /^Set stock/])

  // Always on the page, so an empty list is not mistaken for a missing one.
  const attention = page.getByRole('region', { name: 'Needs attention' })
  await expect(attention).toContainText('Nothing needs your attention right now.')
  await expect(attention.getByRole('link')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Connections' })).toContainText('No connections yet')
  // What waits for a person leads the page; the first-run list comes second.
  await expect(page.getByRole('main').getByRole('region').first()).toHaveAccessibleName('Needs attention')
  await expect(page.getByRole('main').getByRole('region').nth(1)).toHaveAccessibleName('Getting started')
  // The test job is a check for whoever runs the installation: it is in Settings, not here.
  await expect(page.getByRole('region', { name: 'Recent events' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send test job' })).toHaveCount(0)
  // Nothing waits, so the sidebar counts nothing.
  await expect(mainNavigation(page).getByRole('link', { name: 'Orders', exact: true })).toBeVisible()
  await expect(mainNavigation(page).getByRole('link', { name: 'Offers', exact: true })).toBeVisible()

  await setup.getByRole('link', { name: /Connect a channel/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Add connection' })).toBeVisible()
})

test('after the first sync the dashboard leads to the Orders and Offers that wait, and counts Orders by phase', async ({ page }) => {
  await signUp(page)
  await addFakeConnection(page)
  await waitForSeedOrders(page)
  const attention = page.getByRole('region', { name: 'Needs attention' })
  const phases = page.getByRole('region', { name: 'Orders by phase' })
  // With no Product yet, the three open Orders have an unmatched line and none of the five Offers is linked.
  const waitingOrders = attention.getByRole('link', { name: /^3 orders need attention/ })
  const waitingOffers = attention.getByRole('link', { name: /^5 offers have no product/ })
  const phaseCount = (phase: string, count: number) => phases.getByRole('link', { name: new RegExp(`^${phase}\\s*${count}$`) })
  // Offers and Orders are pulled by separate jobs.
  await reloadUntil(page, '/dashboard', async () => {
    await expect(waitingOrders).toBeVisible({ timeout: 1_000 })
    await expect(waitingOffers).toBeVisible({ timeout: 1_000 })
    await expect(phaseCount('Cancelled', 1)).toBeVisible({ timeout: 1_000 })
  })
  await expect(waitingOrders).toContainText('Unmatched line: 3')
  await expect(phaseCount('New', 3)).toBeVisible()
  await expect(phaseCount('Processing', 0)).toBeVisible()
  await expect(phaseCount('Shipped', 0)).toBeVisible()
  await expect(page.getByRole('region', { name: 'Getting started' })).toContainText('1 of 3 done')
  await expect(page.getByRole('region', { name: 'Connections' }).getByRole('link', { name: /Fake marketplace/ })).toContainText('Working')
  // The sidebar counts the same two things, on every page, and says them in the links' names.
  await expect(navLink(page, 'Orders')).toHaveAccessibleName('Orders, 3 need attention')
  await expect(navLink(page, 'Offers')).toHaveAccessibleName('Offers, 5 need attention')
  await expect(navLink(page, 'Products')).toHaveAccessibleName('Products')

  // Each row opens the list it counted.
  const orders = page.getByRole('link', { name: /^fake-order-\d+$/ })
  await waitingOrders.click()
  await expect(page).toHaveURL(/\/orders\?attention=1$/)
  await expect(page.getByRole('group', { name: 'Filters' }).getByRole('link', { name: 'Needs attention' })).toHaveAttribute('aria-current', 'true')
  await expect(orders).toHaveCount(3)
  await expect(page.getByRole('link', { name: 'fake-order-2', exact: true })).toBeHidden()

  await mainNavigation(page).getByRole('link', { name: 'Dashboard' }).click()
  await waitingOffers.click()
  await expect(page).toHaveURL(/\/products\/offers$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Offers that need attention' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Without a product', exact: true }).getByRole('row').filter({ hasText: 'fake-offer-' })).toHaveCount(5)

  await mainNavigation(page).getByRole('link', { name: 'Dashboard' }).click()
  await phaseCount('Cancelled', 1).click()
  await expect(page).toHaveURL(/\/orders\?phase=cancelled$/)
  await expect(page.getByRole('navigation', { name: 'Phase' }).getByRole('link', { name: 'Cancelled' })).toHaveAttribute('aria-current', 'page')
  await expect(orders).toHaveText(['fake-order-2'])

  // A recent event leads to what it is about, named by its Order number.
  await mainNavigation(page).getByRole('link', { name: 'Dashboard' }).click()
  await page.getByRole('region', { name: 'Recent events' }).getByRole('link', { name: 'Order fake-order-1', exact: true }).first().click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('fake-order-1')
  // On the Order's own history a row does not link back to the page it is on.
  await expect(page.getByRole('region', { name: 'History' }).getByRole('link', { name: /fake-order-1/ })).toHaveCount(0)
})
