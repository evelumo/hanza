import type { Page } from '@playwright/test'
import type pg from 'pg'
import { addFakeConnection, addFakeCourier, confirmation, expect, reloadUntil, signUp, test, waitForSeedOrders, type Account } from '../src/fixtures'

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

/**
 * Creates a Shipment for the Order on the page, through the organization's only carrier Connection and to the pickup
 * point the Order names, and waits until its Carrier has confirmed it: the row with its Label, which no longer changes
 * by itself.
 */
async function createShipment(page: Page) {
  const path = new URL(page.url()).pathname
  const shipments = page.getByRole('region', { name: 'Shipments', exact: true })
  await shipments.getByRole('button', { name: 'Create shipment' }).click()
  await confirmation(page, 'Create shipment').getByRole('button', { name: 'Create shipment' }).click()
  await expect(shipments.getByRole('status')).toHaveText('Shipment requested. Its label appears above once the carrier confirms it.')
  const row = shipments.getByRole('row').filter({ hasText: 'Fake carrier' })
  await reloadUntil(page, path, async () => {
    await expect(row.getByRole('link', { name: 'Download label' })).toBeVisible({ timeout: 1_000 })
  })
  return row
}

test('a second organization sees none of the first one’s data and cannot act on it', async ({ page, browser, db, fakeCarrier }) => {
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
  // And a Shipment of that Order with a Label, which A can download.
  const carrierA = await addFakeCourier(page, 'Fake carrier', { stuckAt: 'ready' })
  await page.goto(`/orders/${orderId}`)
  const shipmentA = await createShipment(page)
  const labelPath = (await shipmentA.getByRole('link', { name: 'Download label' }).getAttribute('href'))!
  const shipmentId = labelPath.split('/').at(-2)!
  expect((await page.request.get(labelPath)).status()).toBe(200)

  // Organization B, in a separate browser session.
  const context = await browser.newContext()
  const other = await context.newPage()
  const b = await signUp(other)

  await other.goto('/orders')
  await expect(other.getByText('No orders yet', { exact: true })).toBeVisible()
  await other.goto('/products')
  await expect(other.getByText('No products yet', { exact: true })).toBeVisible()
  await other.goto('/products/offers')
  await expect(other.getByText('Every offer has a product.')).toBeVisible()
  await other.goto('/connections')
  await expect(other.getByText('There are no connections yet.')).toBeVisible()
  for (const path of [`/orders/${orderId}`, `/products/${productId}`, `/connections/${connectionId}`, `/connections/${carrierA.id}`]) {
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
  // The form of the Order's primary action, in the page's header.
  const toProcessing = other
    .getByRole('main')
    .locator('form')
    .filter({ has: other.getByRole('button', { name: 'Change to: Processing' }) })
  await toProcessing.locator('input[name="orderId"]').evaluate((input: HTMLInputElement, id) => (input.value = id), orderId)
  await toProcessing.getByRole('button', { name: 'Change to: Processing' }).click()
  await expect(toProcessing.getByRole('alert')).toHaveText('Not found.')

  // A's Label is not B's to download, under A's Order or under B's own: the same 404 as a Shipment without one.
  for (const path of [labelPath, `/orders/${ownOrderId}/shipments/${shipmentId}/label`]) {
    const answer = await other.request.get(path)
    expect(answer.status(), path).toBe(404)
    expect(await answer.text(), path).toBe('')
  }
  // B's own Shipment gives it a "Cancel shipment" form to send A's Shipment id through. Held at ready like A's, so
  // the row is at rest: a page that re-read itself would put the true id back into the form.
  await addFakeCourier(other, 'Fake carrier', { stuckAt: 'ready' })
  await other.goto(`/orders/${ownOrderId}`)
  const shipmentB = await createShipment(other)
  await shipmentB.locator('input[name="shipmentId"]').evaluateAll((inputs: HTMLInputElement[], id) => inputs.forEach((input) => (input.value = id)), shipmentId)
  await shipmentB.getByRole('button', { name: 'Cancel shipment' }).click()
  await confirmation(other, 'Cancel shipment').getByRole('button', { name: 'Cancel shipment' }).click()
  await expect(shipmentB.getByRole('alert')).toHaveText('Not found.')

  // Nothing changed, neither A's records nor B's own.
  const units = await db.query<{ productId: string; units: number }>(`SELECT "productId", units FROM "stock" WHERE "productId" = ANY($1)`, [
    [productId, ownProductId],
  ])
  expect(Object.fromEntries(units.rows.map((row) => [row.productId, row.units]))).toEqual({ [productId]: 7, [ownProductId]: 3 })
  // Both Orders are still in phase new, on their own organization's default status.
  const statuses = await db.query<{ id: string; phase: string; ownDefault: boolean }>(
    `SELECT o.id, o.phase::text, (s."organizationId" = o."organizationId" AND s."isDefault") AS "ownDefault"
     FROM "order" o JOIN "order_status" s ON s.id = o."statusId" WHERE o.id = ANY($1)`,
    [[orderId, ownOrderId]],
  )
  expect(Object.fromEntries(statuses.rows.map((row) => [row.id, [row.phase, row.ownDefault]]))).toEqual({
    [orderId]: ['new', true],
    [ownOrderId]: ['new', true],
  })
  // A's Shipment is as it was: still ready, never asked to be cancelled, and the Carrier heard nothing about it.
  const shipmentsA = await db.query<{ status: string; cancelRequested: boolean; externalId: string }>(
    `SELECT s.status::text, s."cancelRequestedAt" IS NOT NULL AS "cancelRequested", s."externalId"
     FROM "shipment" s JOIN "organization" o ON o.id = s."organizationId" WHERE s.id = $1 AND o.name = $2`,
    [shipmentId, a.organization],
  )
  expect(shipmentsA.rows).toEqual([{ status: 'ready', cancelRequested: false, externalId: expect.any(String) }])
  expect((await fakeCarrier.calls()).cancels).not.toContain(shipmentsA.rows[0]!.externalId)
  expect((await page.request.get(labelPath)).status()).toBe(200)
  await context.close()
})
