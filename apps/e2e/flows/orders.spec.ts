import { addFakeConnection, expect, reloadUntil, signUp, test, waitForSeedOrders } from '../src/fixtures'

test('a fake Connection syncs, imports Orders and shows the ones that need attention', async ({ page }) => {
  await signUp(page)
  const connectionId = await addFakeConnection(page)
  await expect(page.getByRole('heading', { level: 1, name: 'Fake marketplace' })).toBeVisible()

  // Adding the Connection starts its first sync; nothing else triggers it.
  await waitForSeedOrders(page)
  const orderRow = (number: string) => page.getByRole('row').filter({ has: page.getByRole('link', { name: number, exact: true }) })
  await expect(orderRow('fake-order-1')).toContainText('New')
  // The Channel reported fake-order-2 as cancelled by the buyer.
  await expect(orderRow('fake-order-2')).toContainText('Cancelled')
  // No Product has fake-order-3's SKU.
  await expect(orderRow('fake-order-3')).toContainText('Needs attention')

  await page.getByLabel('Only those needing attention').check()
  await page.getByRole('button', { name: 'Filter' }).click()
  await expect(page).toHaveURL(/attention=1/)
  await page.getByRole('link', { name: 'fake-order-3', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Needs attention' })).toContainText('Unmatched line')

  // "Synchronise now" runs both pulls again; the second Orders pull finds nothing new.
  const sync = page.getByRole('region', { name: 'Synchronisation' })
  const ordersStream = sync.getByRole('row', { name: /Orders/ })
  await reloadUntil(page, `/connections/${connectionId}`, async () => {
    await expect(ordersStream).toContainText('imported 4', { timeout: 1_000 })
  })
  await sync.getByRole('button', { name: 'Synchronise now' }).click()
  await expect(sync.getByRole('status')).toHaveText('Synchronisation requested. Refresh the page in a moment.')
  await reloadUntil(page, `/connections/${connectionId}`, async () => {
    await expect(ordersStream).toContainText('imported 0', { timeout: 1_000 })
  })

  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Connections' }).click()
  await expect(page.getByRole('row', { name: /Fake marketplace/ })).toContainText('Working')
})

test('an Order status change in the panel reaches the fake Channel', async ({ page, fakeChannel }) => {
  await signUp(page)
  await addFakeConnection(page)
  await waitForSeedOrders(page)
  await page.getByRole('link', { name: 'fake-order-1', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('fake-order-1')

  const before = (await fakeChannel.calls()).statusUpdates.length
  const status = page.getByRole('region', { name: 'Status', exact: true })
  await status.getByRole('button', { name: 'Change to: Processing' }).click()
  // From Processing an Order may go back to New, which it could not from New.
  await expect(status.getByRole('button', { name: 'Change to: New' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'History' })).toContainText('Status changed')

  await expect
    .poll(async () => (await fakeChannel.calls()).statusUpdates.slice(before))
    .toContainEqual({ orderExternalId: 'fake-order-1', phase: 'processing' })
})
