import { addFakeConnection, expect, navLink, signUp, test, waitForSeedOrders, type FakeChannelProbe } from '../src/fixtures'

/** Every number the fake Channel was sent for `offerExternalId`, after the first `since` pushes. */
async function pushedTo(fakeChannel: FakeChannelProbe, offerExternalId: string, since: number): Promise<number[]> {
  const { stockPushes } = await fakeChannel.calls()
  return stockPushes
    .slice(since)
    .flat()
    .filter((level) => level.offerExternalId === offerExternalId)
    .map((level) => level.available)
}

const seed = [
  { offer: 'fake-offer-1', name: 'Ceramic mug' },
  { offer: 'fake-offer-2', name: 'Cotton T-shirt M' },
  { offer: 'fake-offer-3', name: 'Poster A3' },
  { offer: 'fake-offer-5', name: 'Linen tote bag' },
]

test('Products created from Offers send the Channel no stock until someone saves it (#137)', async ({ page, fakeChannel, db }) => {
  const account = await signUp(page)
  await addFakeConnection(page)
  // fake-order-1 (2 mugs) is imported first, so it reserves against the mug's unset Stock as soon as the Product exists.
  await waitForSeedOrders(page)
  const before = (await fakeChannel.calls()).stockPushes.length

  await navLink(page, 'Offers').click()
  await expect(page.getByRole('heading', { level: 1, name: 'Offers that need attention' })).toBeVisible()
  const unlinked = page.getByRole('region', { name: 'Without a product', exact: true })
  for (const { name } of seed) await unlinked.getByRole('checkbox', { name: `Select offer ${name}` }).check()
  const create = unlinked.getByRole('region', { name: 'Create products from offers' })
  await expect(create).toContainText('but no stock: nothing is sent to the channels until you save its stock')
  await create.getByRole('button', { name: 'Create products from selected' }).click()
  await expect(create.getByRole('status')).toContainText('Created 4 products.')

  // They wait for their Stock, listed apart from the Offer that still has no Product, and counted in the sidebar.
  const unset = page.getByRole('region', { name: 'Stock not set', exact: true })
  for (const { offer } of seed) await expect(unset.getByRole('row').filter({ hasText: offer })).toContainText('Stock not set')
  await expect(unlinked.getByRole('row').filter({ hasText: 'fake-offer-' })).toHaveCount(1)
  await page.reload()
  await expect(navLink(page, 'Offers')).toHaveAccessibleName('Offers, 5 need attention')

  // The worker has handled the push the mug's Reservation asked for, and sent the Channel nothing: no 0 that ends an Offer.
  await expect
    .poll(async () => {
      const { rows } = await db.query<{ waiting: number }>(
        `SELECT count(*)::int AS "waiting" FROM "offer" o
         JOIN "organization" org ON org."id" = o."organizationId"
         WHERE org."name" = $1 AND o."externalId" = 'fake-offer-1' AND o."stockPushSeq" > o."stockPushedSeq"`,
        [account.organization],
      )
      return rows[0]?.waiting
    })
    .toBe(0)
  for (const { offer } of seed) expect(await pushedTo(fakeChannel, offer, before), offer).toEqual([])

  // Saving the mug's Stock sends its Available (5 − 2 reserved), to its Offer only.
  await unset.getByRole('link', { name: 'Set stock of Ceramic mug' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Ceramic mug' })).toBeVisible()
  const stock = page.getByRole('region', { name: 'Stock', exact: true })
  await expect(stock.getByRole('region', { name: 'Stock not set' })).toContainText('Nothing is sent to the channels until you save')
  await stock.getByLabel('Stock in Main warehouse').fill('5')
  await stock.getByRole('button', { name: 'Save stock' }).click()
  await expect(stock.getByRole('status')).toHaveText('Saved. The new stock will be sent to the channels.')
  await expect(stock.getByRole('region', { name: 'Stock not set' })).toHaveCount(0)
  await expect.poll(() => pushedTo(fakeChannel, 'fake-offer-1', before)).toEqual([3])
  for (const { offer } of seed.slice(1)) expect(await pushedTo(fakeChannel, offer, before), offer).toEqual([])

  await navLink(page, 'Offers').click()
  await expect(page.getByRole('heading', { level: 1, name: 'Offers that need attention' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Stock not set', exact: true }).getByRole('row').filter({ hasText: 'fake-offer-' })).toHaveCount(3)
  await expect(navLink(page, 'Offers')).toHaveAccessibleName('Offers, 4 need attention')
})
