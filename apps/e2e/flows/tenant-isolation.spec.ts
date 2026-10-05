import { addFakeConnection, expect, signUp, test, waitForSeedOrders } from '../src/fixtures'

test('a second organization sees none of the first one’s data', async ({ page, browser, db }) => {
  // Organization A: a Connection with imported Orders and Offers, and a Product.
  await signUp(page)
  const connectionPath = `/connections/${await addFakeConnection(page, 'Tenant A marketplace')}`
  await waitForSeedOrders(page)
  await page.getByRole('link', { name: 'fake-order-1', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('fake-order-1')
  const orderPath = new URL(page.url()).pathname
  await page.goto('/products/new')
  // A SKU no fake Offer has, so this flow sends nothing to the shared fake Channel.
  await page.getByLabel('SKU', { exact: true }).fill('TENANT-A-ONLY')
  await page.getByLabel('Name', { exact: true }).fill('Tenant A product')
  await page.getByRole('button', { name: 'Add product' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Tenant A product' })).toBeVisible()
  const productPath = new URL(page.url()).pathname

  // Organization B, in a separate browser session.
  const context = await browser.newContext()
  const other = await context.newPage()
  const b = await signUp(other)

  await other.goto('/orders')
  await expect(other.getByText('There are no orders yet.')).toBeVisible()
  await other.goto('/products')
  await expect(other.getByText('There are no products yet.')).toBeVisible()
  await other.goto('/products/offers')
  await expect(other.getByText('Every offer has a product.')).toBeVisible()
  await other.goto('/connections')
  await expect(other.getByText('There are no connections yet.')).toBeVisible()

  for (const path of [orderPath, productPath, connectionPath]) {
    await other.goto(path)
    await expect(other.getByRole('heading', { level: 1, name: 'Not found' }), path).toBeVisible()
  }

  const { rows } = await db.query<{ orders: number; products: number; offers: number; connections: number }>(
    `SELECT
       (SELECT count(*)::int FROM "order" WHERE "organizationId" = o.id) AS orders,
       (SELECT count(*)::int FROM "product" WHERE "organizationId" = o.id) AS products,
       (SELECT count(*)::int FROM "offer" WHERE "organizationId" = o.id) AS offers,
       (SELECT count(*)::int FROM "connection" WHERE "organizationId" = o.id) AS connections
     FROM "organization" o WHERE o.name = $1`,
    [b.organization],
  )
  expect(rows).toEqual([{ orders: 0, products: 0, offers: 0, connections: 0 }])
  await context.close()
})
