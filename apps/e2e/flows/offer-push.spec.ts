import { addFakeConnection, expect, reloadUntil, signUp, test, type FakeChannelProbe } from '../src/fixtures'

/** How many numbers the fake Channel was sent for `offerExternalId`, after the first `since` pushes. */
async function pushesOf(fakeChannel: FakeChannelProbe, offerExternalId: string, since: number): Promise<number> {
  const { stockPushes } = await fakeChannel.calls()
  return stockPushes
    .slice(since)
    .flat()
    .filter((level) => level.offerExternalId === offerExternalId).length
}

test('an Offer whose stock the channel rejects shows why, keeps the Connection working, and can be retried', async ({ page, fakeChannel }) => {
  await signUp(page)
  // This Connection's Channel refuses fake-offer-1 (the ceramic mug) and accepts every other Offer.
  const connectionId = await addFakeConnection(page, 'Refusing marketplace', { rejectOffers: 'fake-offer-1' })
  const before = (await fakeChannel.calls()).stockPushes.length

  await page.goto('/products/new')
  await page.getByLabel('SKU', { exact: true }).fill('FAKE-SKU-1')
  await page.getByLabel('Name', { exact: true }).fill('Ceramic mug')
  await page.getByLabel('Initial stock').fill('5')
  await page.getByRole('button', { name: 'Add product' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Ceramic mug' })).toBeVisible()
  const productPath = new URL(page.url()).pathname

  // The push reached the Channel and was refused for this Offer only.
  await expect.poll(() => pushesOf(fakeChannel, 'fake-offer-1', before)).toBeGreaterThan(0)
  const offerRow = page.getByRole('region', { name: 'Offers', exact: true }).getByRole('row').filter({ hasText: 'fake-offer-1' })
  await reloadUntil(page, productPath, async () => {
    await expect(offerRow).toContainText('Rejected by the channel: FAKE_REJECTED.', { timeout: 1_000 })
  })
  await expect(offerRow).toContainText('Active')

  await offerRow.getByRole('link', { name: 'Ceramic mug' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Ceramic mug' })).toBeVisible()
  const stock = page.getByRole('region', { name: 'Stock on the channel', exact: true })
  await expect(stock).toContainText('Rejected by the channel: FAKE_REJECTED.')
  await expect(stock.getByRole('group', { name: 'On the channel', exact: true })).toContainText('Active')
  await expect(stock.getByRole('group', { name: 'Last sent stock', exact: true })).toContainText('not sent yet')
  const offerPath = new URL(page.url()).pathname

  // Retry sends it to the Channel again (the page shows it waiting until then); this Channel still refuses it, so the rejection comes back.
  const sent = await pushesOf(fakeChannel, 'fake-offer-1', before)
  await stock.getByRole('button', { name: 'Retry sending the stock' }).click()
  await expect.poll(() => pushesOf(fakeChannel, 'fake-offer-1', before)).toBe(sent + 1)
  await reloadUntil(page, offerPath, async () => {
    await expect(page.getByRole('region', { name: 'Stock on the channel', exact: true })).toContainText('Rejected by the channel: FAKE_REJECTED.', {
      timeout: 1_000,
    })
  })

  // The Connection stays healthy and lists the rejected Offer.
  await page.goto(`/connections/${connectionId}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Refusing marketplace' })).toBeVisible()
  await expect(page.getByText('Working', { exact: true })).toBeVisible()
  const rejected = page.getByRole('region', { name: 'Offers rejected by the channel', exact: true })
  await expect(rejected.getByRole('row').filter({ hasText: 'fake-offer-1' })).toContainText('Rejected by the channel: FAKE_REJECTED.')
})
