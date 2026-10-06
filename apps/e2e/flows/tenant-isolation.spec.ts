import type { Page } from '@playwright/test'
import type pg from 'pg'
import { addFakeConnection, expect, signUp, test, waitForSeedOrders, type Account } from '../src/fixtures'

const lastSegment = (page: Page) => new URL(page.url()).pathname.split('/').pop()!

async function rowsOf(db: pg.Pool, account: Account) {
  const { rows } = await db.query<{ orders: number; products: number; offers: number; connections: number }>(
    `SELECT
       (SELECT count(*)::int FROM "order" WHERE "organizationId" = o.id) AS orders,
       (SELECT count(*)::int FROM "product" WHERE "organizationId" = o.id) AS products,
       (SELECT count(*)::int FROM "offer" WHERE "organizationId" = o.id) AS offers,
       (SELECT count(*)::int FROM "connection" WHERE "organizationId" = o.id) AS connections
     FROM "organization" o WHERE o.name = $1`,
    [account.organization],
  )
  return rows
}

async function createProduct(page: Page, sku: string, name: string, stock: string): Promise<string> {
  await page.goto('/products/new')
  // SKUs no fake Offer has, so this flow sends nothing to the shared fake Channel.
  await page.getByLabel('SKU', { exact: true }).fill(sku)
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByLabel('Initial stock').fill(stock)
  await page.getByRole('button', { name: 'Add product' }).click()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
  return lastSegment(page)
}

test('a second organization sees none of the first one’s data and cannot act on it', async ({ page, browser, db }) => {
  // Organization A: a Connection with imported Orders and Offers, and a Product with Stock 7.
  const a = await signUp(page)
  const connectionId = await addFakeConnection(page, 'Tenant A marketplace')
  await waitForSeedOrders(page)
  await page.getByRole('link', { name: 'fake-order-1', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('fake-order-1')
  const orderId = lastSegment(page)
  const productId = await createProduct(page, 'TENANT-A-ONLY', 'Tenant A product', '7')
  // The control: A's rows exist, so B's zeros below mean something.
  expect(await rowsOf(db, a)).toEqual([{ orders: 4, products: 1, offers: 5, connections: 1 }])

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
  for (const path of [`/orders/${orderId}`, `/products/${productId}`, `/connections/${connectionId}`]) {
    await other.goto(path)
    await expect(other.getByRole('heading', { level: 1, name: 'Not found' }), path).toBeVisible()
  }
  expect(await rowsOf(db, b)).toEqual([{ orders: 0, products: 0, offers: 0, connections: 0 }])

  // B tampers with its own forms to send A's ids to the server actions. Hidden inputs have no
  // role or label, hence the CSS selectors; they stand for a crafted request.
  const ownProductId = await createProduct(other, 'TENANT-B-ONLY', 'Tenant B product', '3')
  const stock = other.getByRole('region', { name: 'Stock', exact: true })
  await stock.locator('input[name="productId"]').evaluate((input: HTMLInputElement, id) => (input.value = id), productId)
  await stock.getByLabel('Stock').fill('999')
  await stock.getByRole('button', { name: 'Save stock' }).click()
  await expect(stock.getByRole('alert')).toHaveText('Not found.')

  await addFakeConnection(other, 'Tenant B marketplace')
  await waitForSeedOrders(other)
  await other.getByRole('link', { name: 'fake-order-1', exact: true }).click()
  await expect(other.getByRole('heading', { level: 1 })).toContainText('fake-order-1')
  const ownOrderId = lastSegment(other)
  const toProcessing = other
    .getByRole('region', { name: 'Status', exact: true })
    .locator('form')
    .filter({ has: other.getByRole('button', { name: 'Change to: Processing' }) })
  await toProcessing.locator('input[name="orderId"]').evaluate((input: HTMLInputElement, id) => (input.value = id), orderId)
  await toProcessing.getByRole('button', { name: 'Change to: Processing' }).click()
  await expect(toProcessing.getByRole('alert')).toHaveText('Not found.')

  // Nothing changed, neither A's records nor B's own.
  const units = await db.query<{ productId: string; units: number }>(`SELECT "productId", units FROM "stock" WHERE "productId" = ANY($1)`, [
    [productId, ownProductId],
  ])
  expect(Object.fromEntries(units.rows.map((row) => [row.productId, row.units]))).toEqual({ [productId]: 7, [ownProductId]: 3 })
  const statuses = await db.query<{ id: string; status: string }>(`SELECT id, status::text FROM "order" WHERE id = ANY($1)`, [[orderId, ownOrderId]])
  expect(Object.fromEntries(statuses.rows.map((row) => [row.id, row.status]))).toEqual({ [orderId]: 'new', [ownOrderId]: 'new' })
  await context.close()
})
