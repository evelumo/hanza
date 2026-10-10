import type { Locator, Page } from '@playwright/test'
import { addFakeConnection, addFakeCourier, confirmation, expect, reloadUntil, signUp, test, waitForSeedOrders } from '../src/fixtures'

/**
 * Chooses the fake Carrier's address service and gives the parcel's dimensions. The seed Orders carry no phone,
 * which the fake Carrier's pickup point service ("Fake locker") refuses, like a real locker network does.
 */
async function toAddress(shipments: Locator, weight = '1.25') {
  await shipments.getByLabel('Service').selectOption('courier')
  await shipments.getByLabel('Length (cm)').fill('30,5')
  await shipments.getByLabel('Width (cm)').fill('20')
  await shipments.getByLabel('Height (cm)').fill('10')
  await shipments.getByLabel('Weight (kg)').fill(weight)
}

const CREATED = 'Shipment requested. Its label appears above once the carrier confirms it.'

/** Opens a seed Order from the list and returns its path and its "Shipments" section. */
async function openOrder(page: Page, number: string) {
  await page.goto('/orders')
  await page.getByRole('link', { name: number, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText(number)
  return { path: new URL(page.url()).pathname, shipments: page.getByRole('region', { name: 'Shipments', exact: true }) }
}

test('a Shipment is created for an Order, its Label downloads, and the Carrier taking the parcel ships the Order', async ({ page, fakeCarrier }) => {
  await signUp(page)
  // A pickup ships only an Order whose lines are all linked: fake-order-1 wants 2 × FAKE-SKU-1, so the Product comes first.
  await page.goto('/products/new')
  await page.getByLabel('SKU', { exact: true }).fill('FAKE-SKU-1')
  await page.getByLabel('Name', { exact: true }).fill('Ceramic mug')
  await page.getByLabel('Initial stock').fill('5')
  await page.getByRole('button', { name: 'Add product' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Ceramic mug' })).toBeVisible()
  await addFakeConnection(page)
  await waitForSeedOrders(page)
  const carrier = await addFakeCourier(page)

  const { path, shipments } = await openOrder(page, 'fake-order-1')
  // The Buyer chose a pickup point on the Channel: the page shows it, and the form starts from it.
  const buyer = page.getByRole('region', { name: 'Buyer', exact: true })
  await expect(buyer).toContainText('Parcel locker')
  await expect(buyer).toContainText('FAKE01')
  await expect(shipments.getByLabel('Carrier')).toHaveValue(carrier.id)
  await expect(shipments.getByLabel('Service')).toHaveValue('locker')
  await expect(shipments.getByLabel('Pickup point')).toHaveValue('FAKE01')
  // A prepaid Order: nothing for the Carrier to collect.
  await expect(shipments.getByLabel(/Cash on delivery/)).toHaveCount(0)
  await expect(shipments.getByLabel('Parcel size')).toHaveValue('small')
  // The fields follow the service: an address service asks for dimensions, and for no pickup point.
  await toAddress(shipments)
  await expect(shipments.getByLabel('Pickup point')).toHaveCount(0)
  await expect(shipments.getByLabel('Parcel size')).toHaveCount(0)
  await shipments.getByRole('button', { name: 'Create shipment' }).click()
  await expect(shipments.getByRole('status')).toHaveText(CREATED)

  // The page re-reads itself while the Carrier is being asked: the worker's answer shows without a reload.
  const row = shipments.getByRole('row').filter({ hasText: 'Fake carrier' })
  await expect(row).toContainText('Waiting for carrier', { timeout: 30_000 })
  await expect(row).toContainText('Being arranged with the carrier.')
  await expect(row.getByRole('link', { name: 'Download label' })).toHaveCount(0)
  await row.getByRole('button', { name: 'Check status' }).click()
  await expect(row.getByRole('status')).toHaveText('The carrier is being asked. Refresh the page in a moment.')
  await expect(row).toContainText('Ready to send', { timeout: 30_000 })
  await expect(row).toContainText('The label is ready. Print it and stick it on the parcel.', { timeout: 30_000 })
  const [mine] = (await fakeCarrier.calls()).shipments.filter((shipment) => shipment.account === carrier.account)
  expect(mine).toMatchObject({ status: 'ready', trackingNumber: expect.stringMatching(/^FAKE\d{6}$/) })
  await expect(row).toContainText(mine!.trackingNumber)

  // The Label is a file to print: an attachment named after the tracking number, never cached.
  const label = row.getByRole('link', { name: 'Download label' })
  const [download] = await Promise.all([page.waitForEvent('download'), label.click()])
  expect(download.suggestedFilename()).toBe(`label-${mine!.trackingNumber}.pdf`)
  const file = await page.request.get((await label.getAttribute('href'))!)
  expect(file.status()).toBe(200)
  expect(file.headers()).toMatchObject({
    'content-type': 'application/pdf',
    'content-disposition': `attachment; filename="label-${mine!.trackingNumber}.pdf"`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  expect((await file.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-')

  // A printed Label is not a parcel the Carrier has: the Order is still open.
  await page.goto(path)
  await expect(page.getByText('Phase: New')).toBeVisible()
  // The parcel is handed over. Hanza would ask the Carrier in a quarter of an hour; the person asks now.
  await row.getByRole('button', { name: 'Check status' }).click()
  await expect(row.getByRole('status')).toHaveText('The carrier is being asked. Refresh the page in a moment.')
  // The Shipment and its Order change in one transaction, and a page reads them in two queries: both are waited for.
  await reloadUntil(page, path, async () => {
    await expect(row).toContainText('In transit', { timeout: 1_000 })
    await expect(page.getByText('Phase: Shipped')).toBeVisible({ timeout: 1_000 })
  })
  await expect(page.getByRole('region', { name: 'History' })).toContainText('The carrier took the parcel')
  // With the Carrier it can no longer be cancelled here, and a shipped Order gets no new Shipment.
  await expect(row.getByRole('button', { name: 'Cancel shipment' })).toHaveCount(0)
  await expect(shipments).toContainText('This order is shipped, so no shipment can be created for it.')
  await expect(shipments.getByRole('button', { name: 'Create shipment' })).toHaveCount(0)
  expect((await fakeCarrier.calls()).shipments.filter((shipment) => shipment.account === carrier.account)).toEqual([{ ...mine, status: 'in_transit' }])
})

test('without a carrier Connection an Order says so, and a pickup point the Carrier refuses fails the Shipment with its code', async ({ page, fakeCarrier }) => {
  await signUp(page)
  await addFakeConnection(page)
  await waitForSeedOrders(page)

  const first = await openOrder(page, 'fake-order-1')
  await expect(first.shipments).toContainText('Connect a carrier first')
  await expect(first.shipments.getByRole('link', { name: 'Go to Connections' })).toHaveAttribute('href', '/connections')
  await expect(first.shipments.getByRole('button', { name: 'Create shipment' })).toHaveCount(0)
  // The Channel reported fake-order-2 cancelled: there is nothing to send, whatever is connected.
  const cancelled = await openOrder(page, 'fake-order-2')
  await expect(cancelled.shipments).toContainText('This order is cancelled, so no shipment can be created for it.')
  await expect(cancelled.shipments).not.toContainText('Connect a carrier first')

  const carrier = await addFakeCourier(page, 'Fake carrier', { rejectPickupPoints: 'FAKE01' })
  const { path, shipments } = await openOrder(page, 'fake-order-1')
  await expect(shipments.getByLabel('Pickup point')).toHaveValue('FAKE01')
  await shipments.getByRole('button', { name: 'Create shipment' }).click()
  await expect(shipments.getByRole('status')).toHaveText(CREATED)
  const row = shipments.getByRole('row').filter({ hasText: 'Fake carrier' })
  await reloadUntil(page, path, async () => {
    await expect(row).toContainText('Failed', { timeout: 1_000 })
  })
  await expect(row).toContainText('The carrier refused this shipment. The carrier’s answer: pickup_point_unknown')
  // Nothing is left to do with it, and the Carrier made no Shipment.
  await expect(row.getByRole('button')).toHaveCount(0)
  await expect(row.getByRole('link')).toHaveCount(0)
  expect((await fakeCarrier.calls()).shipments.filter((shipment) => shipment.account === carrier.account)).toEqual([])
  // The Order is as open as it was, and another Shipment can be tried.
  await expect(page.getByText('Phase: New')).toBeVisible()
  await expect(shipments.getByRole('button', { name: 'Create shipment' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'History' })).toContainText('Shipment failed')
})

test('cancelling a Shipment the Carrier has confirmed asks first, then asks the Carrier', async ({ page, fakeCarrier }) => {
  await signUp(page)
  await addFakeConnection(page)
  await waitForSeedOrders(page)
  // Held at ready: however often it is checked, the Carrier never takes the parcel.
  const carrier = await addFakeCourier(page, 'Fake carrier', { stuckAt: 'ready' })

  const { path, shipments } = await openOrder(page, 'fake-order-4')
  await expect(shipments.getByLabel('Pickup point')).toHaveValue('FAKE02')
  // Not a weight: the form says which field, and keeps the service that was chosen and what was typed.
  await toAddress(shipments, 'heavy')
  await shipments.getByRole('button', { name: 'Create shipment' }).click()
  await expect(shipments.getByRole('alert')).toHaveText('Check the fields.')
  await expect(shipments.getByLabel('Weight (kg)')).toHaveAccessibleDescription('Enter a weight in kilograms above 0, e.g. 2 or 0.5.')
  await expect(shipments.getByLabel('Service')).toHaveValue('courier')
  await expect(shipments.getByLabel('Length (cm)')).toHaveValue('30,5')
  await shipments.getByLabel('Weight (kg)').fill('1.25')
  await shipments.getByRole('button', { name: 'Create shipment' }).click()
  await expect(shipments.getByRole('status')).toHaveText(CREATED)

  const row = shipments.getByRole('row').filter({ hasText: 'Fake carrier' })
  await expect(row).toContainText('Fake courier')
  await reloadUntil(page, path, async () => {
    await expect(row).toContainText('Waiting for carrier', { timeout: 1_000 })
  })
  await row.getByRole('button', { name: 'Check status' }).click()
  await expect(row.getByRole('status')).toHaveText('The carrier is being asked. Refresh the page in a moment.')
  await reloadUntil(page, path, async () => {
    await expect(row.getByRole('link', { name: 'Download label' })).toBeVisible({ timeout: 1_000 })
  })
  const [mine] = (await fakeCarrier.calls()).shipments.filter((shipment) => shipment.account === carrier.account)
  expect(mine).toMatchObject({ status: 'ready' })

  const cancel = row.getByRole('button', { name: 'Cancel shipment' })
  const dialog = confirmation(page, 'Cancel shipment')
  await cancel.click()
  await expect(dialog).toContainText('Cancel this shipment? Its label can no longer be used.')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(row).toContainText('Ready to send')
  expect((await fakeCarrier.calls()).cancels).not.toContain(mine!.externalId)

  await cancel.click()
  await dialog.getByRole('button', { name: 'Cancel shipment' }).click()
  await expect(dialog).toBeHidden()
  // The Carrier knows this Shipment, so it is the Carrier that cancels it: the page says so until the worker has asked.
  await expect(row).toContainText(/The carrier is being asked to cancel this shipment\.|Cancelled/)
  await reloadUntil(page, path, async () => {
    await expect(row).toContainText('Cancelled', { timeout: 1_000 })
  })
  // A cancelled Shipment has no Label and nothing to check or cancel.
  await expect(row.getByRole('link', { name: 'Download label' })).toHaveCount(0)
  await expect(row.getByRole('button')).toHaveCount(0)
  expect((await fakeCarrier.calls()).cancels.filter((externalId) => externalId === mine!.externalId)).toEqual([mine!.externalId])
  await expect(page.getByText('Phase: New')).toBeVisible()
})
