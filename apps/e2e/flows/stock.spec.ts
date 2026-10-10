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

test('a Product linked to a fake Offer gets its Available pushed to the Channel', async ({ page, fakeChannel }) => {
  await signUp(page)
  await addFakeConnection(page)
  // Imported first, so fake-order-1 (2 mugs) reserves stock as soon as the Product exists.
  await waitForSeedOrders(page)
  const before = (await fakeChannel.calls()).stockPushes.length

  await navLink(page, 'Products').click()
  await page.getByRole('link', { name: 'Add product' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Add product' })).toBeVisible()
  await page.getByLabel('SKU', { exact: true }).fill('FAKE-SKU-1')
  await page.getByLabel('Name', { exact: true }).fill('Ceramic mug')
  await page.getByLabel('Initial stock').fill('5')
  await page.getByRole('button', { name: 'Add product' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Ceramic mug' })).toBeVisible()
  const productPath = new URL(page.url()).pathname
  const figure = (name: string) => page.getByRole('group', { name, exact: true })

  // The fake Offer with the same SKU is linked, and fake-order-1's line now reserves 2 of the 5.
  const offerRow = page.getByRole('region', { name: 'Offers', exact: true }).getByRole('row').filter({ hasText: 'fake-offer-1' })
  await expect(offerRow).toContainText('By SKU')
  await reloadUntil(page, productPath, async () => {
    await expect(figure('Reserved').getByText('2', { exact: true })).toBeVisible({ timeout: 1_000 })
  })
  await expect(figure('Available').getByText('3', { exact: true })).toBeVisible()
  await expect.poll(() => lastPushed(fakeChannel, 'fake-offer-1', before)).toBe(3)

  const stock = page.getByRole('region', { name: 'Stock', exact: true })
  await stock.getByLabel('Stock').fill('10')
  await stock.getByRole('button', { name: 'Save stock' }).click()
  await expect(stock.getByRole('status')).toHaveText('Saved. The new stock will be sent to the channels.')
  await expect(figure('Available').getByText('8', { exact: true })).toBeVisible()

  await expect.poll(() => lastPushed(fakeChannel, 'fake-offer-1', before)).toBe(8)
  await reloadUntil(page, productPath, async () => {
    await expect(offerRow).toContainText('8 units', { timeout: 1_000 })
  })

  // Linking the line cleared fake-order-1's only attention reason.
  await page.goto('/orders')
  const order = page.getByRole('row').filter({ has: page.getByRole('link', { name: 'fake-order-1', exact: true }) })
  await expect(order).toContainText('New')
  await expect(order).not.toContainText('Needs attention')
})
