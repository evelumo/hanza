import { addFakeConnection, expect, signUp, test, waitForSeedOrders } from '../src/fixtures'

test('an own Order status within a phase: added in Settings, chosen on an Order, filtered by, and never sent to the Channel', async ({
  page,
  fakeChannel,
  db,
}) => {
  await signUp(page)
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Order statuses' })).toBeVisible()
  // Each phase is its own section; its default status is named after it until someone renames it.
  const processing = page.getByRole('region', { name: 'Processing', exact: true })
  await expect(processing.getByRole('textbox', { name: 'Name of Processing' })).toHaveValue('')
  await processing.getByRole('textbox', { name: 'Name', exact: true }).fill('Packed')
  await processing.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(processing.getByRole('textbox', { name: 'Name of Packed' })).toHaveValue('Packed')

  await addFakeConnection(page)
  await waitForSeedOrders(page)
  await page.getByRole('link', { name: 'fake-order-1', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('fake-order-1')
  const orderId = new URL(page.url()).pathname.split('/').pop()!

  // A change of phase reaches the Channel, as before.
  const before = (await fakeChannel.calls()).statusUpdates.length
  const status = page.getByRole('region', { name: 'Status', exact: true })
  await status.getByRole('button', { name: 'Change to: Processing' }).click()
  await expect(status.getByRole('button', { name: 'Change to: Packed' })).toBeVisible()
  await expect
    .poll(async () => (await fakeChannel.calls()).statusUpdates.slice(before))
    .toEqual([{ orderExternalId: 'fake-order-1', phase: 'processing' }])

  // A move within the phase only changes the label: the Order stays in Processing and nothing is marked for the Channel.
  await status.getByRole('button', { name: 'Change to: Packed' }).click()
  await expect(status.getByRole('button', { name: 'Change to: Processing' })).toBeVisible()
  await expect(page.getByText('Phase: Processing')).toBeVisible()
  await expect(page.getByRole('region', { name: 'History' })).toContainText('Processing → Packed')
  const { rows } = await db.query<{ phase: string; name: string | null; seq: number; pending: boolean }>(
    `SELECT o.phase::text AS phase, s.name, o."statusPushSeq" AS seq, o."statusPushDueAt" IS NOT NULL AS pending
     FROM "order" o JOIN "order_status" s ON s.id = o."statusId" AND s."organizationId" = o."organizationId" WHERE o.id = $1`,
    [orderId],
  )
  expect(rows).toEqual([{ phase: 'processing', name: 'Packed', seq: 1, pending: false }])
  expect((await fakeChannel.calls()).statusUpdates.slice(before)).toEqual([{ orderExternalId: 'fake-order-1', phase: 'processing' }])

  // The list filters by status (grouped by phase) and by phase.
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Orders' }).click()
  await page.getByRole('combobox', { name: 'Status' }).selectOption({ label: 'Packed' })
  await page.getByRole('button', { name: 'Filter' }).click()
  await expect(page.getByRole('link', { name: 'fake-order-1', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'fake-order-2', exact: true })).toBeHidden()
  // Links from before Order statuses carried a phase in `status`; they still filter by it.
  await page.goto('/orders?status=processing')
  await expect(page.getByRole('combobox', { name: 'Phase' })).toHaveValue('processing')
  await expect(page.getByRole('link', { name: 'fake-order-1', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'fake-order-3', exact: true })).toBeHidden()
})
