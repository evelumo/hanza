import { addFakeConnection, confirmation, expect, navLink, orderPrimaryAction, reloadUntil, signUp, test, waitForSeedOrders } from '../src/fixtures'

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

  await page.getByRole('group', { name: 'Filters' }).getByRole('link', { name: 'Needs attention' }).click()
  await expect(page).toHaveURL(/attention=1/)
  await page.getByRole('link', { name: 'fake-order-3', exact: true }).click()
  // The notice names the way out for each reason: an unmatched line is linked in the Lines section.
  const attention = page.getByRole('region', { name: 'Needs attention' })
  await expect(attention).toContainText('Unmatched line')
  await expect(attention.getByRole('link', { name: 'Go to Lines' })).toHaveAttribute('href', '#lines')
  await expect(page.getByRole('region', { name: 'Lines', exact: true }).getByRole('button', { name: 'Link', exact: true })).toBeVisible()

  // "Synchronise now" runs both pulls again; the second Orders pull finds nothing new.
  const sync = page.getByRole('region', { name: 'Synchronisation' })
  const ordersStream = sync.getByRole('row', { name: /Orders/ })
  await reloadUntil(page, `/connections/${connectionId}`, async () => {
    await expect(ordersStream).toContainText('imported 4', { timeout: 1_000 })
  })
  // The button is in the page's header; the answer shows where the results of the run will.
  await page.getByRole('button', { name: 'Synchronise now' }).click()
  await expect(sync.getByRole('status')).toHaveText('Synchronisation requested. Refresh the page in a moment.')
  await reloadUntil(page, `/connections/${connectionId}`, async () => {
    await expect(ordersStream).toContainText('imported 0', { timeout: 1_000 })
  })

  await navLink(page, 'Connections').click()
  await expect(page.getByRole('row', { name: /Fake marketplace/ })).toContainText('Working')
})

test('the Orders list filters by phase, by status and by what needs attention', async ({ page }) => {
  await signUp(page)
  await addFakeConnection(page)
  await waitForSeedOrders(page)
  const order = (number: string) => page.getByRole('link', { name: number, exact: true })
  const phases = page.getByRole('navigation', { name: 'Phase' })
  const filters = page.getByRole('group', { name: 'Filters' })
  await expect(phases.getByRole('link', { name: 'All' })).toHaveAttribute('aria-current', 'page')
  await expect(filters.getByRole('link', { name: 'Clear filters' })).toBeHidden()

  // Only fake-order-2 was cancelled (by its buyer, as the Channel reported).
  await phases.getByRole('link', { name: 'Cancelled' }).click()
  await expect(page).toHaveURL(/\/orders\?phase=cancelled$/)
  await expect(phases.getByRole('link', { name: 'Cancelled' })).toHaveAttribute('aria-current', 'page')
  await expect(order('fake-order-2')).toBeVisible()
  await expect(order('fake-order-1')).toBeHidden()

  // A chip narrows the phase further and is taken off the same way. With no Product yet, every open Order has an unmatched line.
  await phases.getByRole('link', { name: 'New' }).click()
  await expect(order('fake-order-1')).toBeVisible()
  await expect(order('fake-order-2')).toBeHidden()
  const attention = filters.getByRole('link', { name: 'Needs attention' })
  await attention.click()
  await expect(page).toHaveURL(/\/orders\?phase=new&attention=1$/)
  await expect(attention).toHaveAttribute('aria-current', 'true')
  await expect(order('fake-order-3')).toBeVisible()
  await attention.click()
  await expect(page).toHaveURL(/\/orders\?phase=new$/)
  await expect(attention).not.toHaveAttribute('aria-current')

  // A status belongs to one phase: choosing one drops the phase, and choosing a phase drops the status again.
  const statusFilter = filters.getByLabel('Status')
  await statusFilter.selectOption({ label: 'Cancelled' })
  await filters.getByRole('button', { name: 'Filter' }).click()
  await expect(page).toHaveURL(/\/orders\?status=[^&]+$/)
  // The list is now within that status's phase: its tab is the current one, not "All".
  await expect(phases.getByRole('link', { name: 'Cancelled' })).toHaveAttribute('aria-current', 'page')
  await expect(phases.getByRole('link', { name: 'All' })).not.toHaveAttribute('aria-current')
  await expect(order('fake-order-2')).toBeVisible()
  await expect(order('fake-order-1')).toBeHidden()
  await phases.getByRole('link', { name: 'New' }).click()
  await expect(page).toHaveURL(/\/orders\?phase=new$/)
  await expect(statusFilter).toHaveValue('')
  await expect(order('fake-order-1')).toBeVisible()

  // No seed Order waits for a payment: the list says that nothing matches instead of looking empty.
  await filters.getByRole('link', { name: 'Awaiting payment' }).click()
  await expect(page).toHaveURL(/\/orders\?phase=new&payment=awaiting$/)
  await expect(page.getByText('No orders match these filters')).toBeVisible()

  await filters.getByRole('link', { name: 'Clear filters' }).click()
  await expect(page).toHaveURL(/\/orders$/)
  await expect(phases.getByRole('link', { name: 'All' })).toHaveAttribute('aria-current', 'page')
  for (const number of ['fake-order-1', 'fake-order-2', 'fake-order-3', 'fake-order-4']) await expect(order(number)).toBeVisible()
})

test('an Order status change in the panel reaches the fake Channel', async ({ page, fakeChannel }) => {
  await signUp(page)
  await addFakeConnection(page)
  await waitForSeedOrders(page)
  await page.getByRole('link', { name: 'fake-order-1', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('fake-order-1')

  const before = (await fakeChannel.calls()).statusUpdates.length
  const status = page.getByRole('region', { name: 'Status', exact: true })
  // On to the next phase is the page's one primary action, in its header; it is not repeated under "Status".
  await expect(page.getByRole('button', { name: 'Change to: Processing' })).toHaveCount(1)
  await expect(status.getByRole('button', { name: 'Change to: Processing' })).toHaveCount(0)
  await expect(status.getByRole('button', { name: 'Change to: Shipped' })).toBeVisible()
  await orderPrimaryAction(page, 'Change to: Processing').click()
  // From Processing the next phase is Shipped, and an Order may go back to New, which it could not from New.
  await expect(orderPrimaryAction(page, 'Change to: Shipped')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Change to: Shipped' })).toHaveCount(1)
  await expect(status.getByRole('button', { name: 'Change to: New' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'History' })).toContainText('Status changed')

  await expect
    .poll(async () => (await fakeChannel.calls()).statusUpdates.slice(before))
    .toContainEqual({ orderExternalId: 'fake-order-1', phase: 'processing' })
})

test('cancelling an Order asks first: backing out changes nothing, confirming cancels it', async ({ page, fakeChannel }) => {
  await signUp(page)
  await addFakeConnection(page)
  await waitForSeedOrders(page)
  await page.getByRole('link', { name: 'fake-order-1', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('fake-order-1')

  const before = (await fakeChannel.calls()).statusUpdates.length
  const status = page.getByRole('region', { name: 'Status', exact: true })
  const cancel = status.getByRole('button', { name: 'Change to: Cancelled' })
  const dialog = confirmation(page, 'Change to: Cancelled')

  await cancel.click()
  await expect(dialog).toContainText('Cancel the order? The reservations will be released and this cannot be undone.')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toBeHidden()
  // Back where the person was, with the Order untouched.
  await expect(cancel).toBeFocused()
  await expect(page.getByText('Phase: New')).toBeVisible()

  await cancel.click()
  await dialog.getByRole('button', { name: 'Change to: Cancelled' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText('Phase: Cancelled')).toBeVisible()
  await expect(status).toContainText('The order is in a final phase (Cancelled) and has no other status to move to.')
  // A closed Order has nowhere to go on to, so no primary action either.
  await expect(page.getByRole('main').getByRole('button', { name: /^Change to:/ })).toHaveCount(0)
  // The Channel heard of the cancellation only, so the first, abandoned attempt sent nothing.
  await expect
    .poll(async () => (await fakeChannel.calls()).statusUpdates.slice(before))
    .toEqual([{ orderExternalId: 'fake-order-1', phase: 'cancelled' }])
})
