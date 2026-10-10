import { addFakeConnection, expect, navLink, reloadUntil, signUp, test, waitForSeedOrders, type FakeChannelProbe } from '../src/fixtures'

/** The last Available the fake Channel received for `offerExternalId`, after the first `since` pushes. */
async function lastPushed(fakeChannel: FakeChannelProbe, offerExternalId: string, since: number): Promise<number | undefined> {
  const { stockPushes } = await fakeChannel.calls()
  return stockPushes
    .slice(since)
    .flat()
    .filter((level) => level.offerExternalId === offerExternalId)
    .at(-1)?.available
}

test('a second Warehouse: Stock per Warehouse, a Channel counting only it, and a moved Reservation', async ({ page, fakeChannel }) => {
  await signUp(page)
  const connectionId = await addFakeConnection(page)
  // fake-order-1 wants 2 × FAKE-SKU-1; it reserves as soon as the Product exists.
  await waitForSeedOrders(page)
  const before = (await fakeChannel.calls()).stockPushes.length

  await navLink(page, 'Warehouses').click()
  await expect(page.getByRole('heading', { level: 1, name: 'Warehouses' })).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: 'Main warehouse' })).toContainText('Default')
  await page.getByLabel('Name', { exact: true }).fill('North')
  await page.getByRole('button', { name: 'Add warehouse' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'North' })).toBeVisible()

  // Initial stock goes to the default Warehouse, which comes first: fake-order-1 reserves there.
  await page.goto('/products/new')
  await page.getByLabel('SKU', { exact: true }).fill('FAKE-SKU-1')
  await page.getByLabel('Name', { exact: true }).fill('Ceramic mug')
  await page.getByLabel('Initial stock').fill('5')
  await page.getByRole('button', { name: 'Add product' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Ceramic mug' })).toBeVisible()
  const productPath = new URL(page.url()).pathname
  const stock = page.getByRole('region', { name: 'Stock', exact: true })
  const warehouseRow = (name: string) => stock.getByRole('row').filter({ hasText: name })
  await reloadUntil(page, productPath, async () => {
    await expect(page.getByRole('region', { name: 'Open reservations' })).toContainText('in Main warehouse', { timeout: 1_000 })
  })
  // Main 5 − 2 = 3, North 0: told what one Warehouse can cover.
  await expect.poll(() => lastPushed(fakeChannel, 'fake-offer-1', before)).toBe(3)

  await stock.getByLabel('Stock in North').fill('2')
  await warehouseRow('North').getByRole('button', { name: 'Save stock' }).click()
  await expect(warehouseRow('North').getByRole('status')).toHaveText('Saved. The new stock will be sent to the channels.')

  // The Channel counts only North now: told North's 2.
  await page.goto(`/connections/${connectionId}`)
  const choice = page.getByRole('region', { name: 'Warehouses counted for this channel' })
  await choice.getByRole('radio', { name: 'Only the chosen warehouses' }).check()
  await choice.getByRole('checkbox', { name: 'North' }).check()
  await choice.getByRole('button', { name: 'Save warehouses' }).click()
  await expect(choice.getByRole('status')).toHaveText('Saved. The new numbers will be sent to this channel.')
  await expect.poll(() => lastPushed(fakeChannel, 'fake-offer-1', before)).toBe(2)

  // Moving fake-order-1's Reservation into North uses up North's 2.
  await page.goto('/orders')
  await page.getByRole('link', { name: 'fake-order-1', exact: true }).click()
  const moveTo = page.getByLabel('Move the reservation to')
  await moveTo.selectOption({ label: 'North' })
  await page.getByRole('button', { name: 'Move', exact: true }).click()
  // Sitting in North now, it can only move back to Main.
  await expect(moveTo.locator('option')).toHaveText(['Main warehouse'])
  await expect.poll(() => lastPushed(fakeChannel, 'fake-offer-1', before)).toBe(0)

  await page.goto(productPath)
  await expect(warehouseRow('Main warehouse')).toContainText('5')
  await expect(page.getByRole('region', { name: 'Open reservations' })).toContainText('in North')
})
