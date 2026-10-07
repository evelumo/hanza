import type { Page } from '@playwright/test'
import { expect, reloadUntil, signUp, test } from '../src/fixtures'

const CODE = /^[A-Z]{3} [A-Z]{3} [A-Z]{3}$/

/** Waits until the sign-in page shows its code (the worker asks the Channel first) and returns it. */
async function shownCode(page: Page): Promise<string> {
  const region = page.getByRole('region', { name: 'Your code' })
  const code = region.getByText(CODE)
  await expect(code).toBeVisible({ timeout: 20_000 })
  await expect(region.getByRole('link', { name: 'Open the Test OAuth channel sign-in page' })).toHaveAttribute(
    'href',
    /^https:\/\/fake-oauth\.hanza\.test\/activate\?code=[A-Z]{9}$/,
  )
  return (await code.textContent())!.trim()
}

async function startConnecting(page: Page, name: string): Promise<string> {
  await page.goto('/connections/new')
  await page.getByRole('link', { name: /Test OAuth channel/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Add connection: Test OAuth channel' })).toBeVisible()
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByRole('button', { name: 'Continue to sign-in' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to Test OAuth channel' })).toBeVisible()
  return shownCode(page)
}

test('connects a Channel by signing in, then signs in again after the sign-in stops working', async ({ page, fakeOAuth }) => {
  await signUp(page)
  const name = 'Seller account'
  const code = await startConnecting(page, name)

  // The person approves on the Channel's page; the sign-in page notices on its own and opens the new Connection.
  await fakeOAuth.approve(code)
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('Signed in as fake-seller')).toBeVisible()
  const connectionPath = new URL(page.url()).pathname
  await reloadUntil(page, connectionPath, async () => {
    await expect(page.getByText('Working', { exact: true })).toBeVisible({ timeout: 1_000 })
  })

  // The seller unlinks the application: the refresh is refused and the Connection waits for a sign-in.
  await fakeOAuth.revokeAll()
  await page.getByRole('button', { name: 'Synchronise now' }).click()
  await expect(page.getByText('Synchronisation requested. Refresh the page in a moment.')).toBeVisible()
  const notice = page.getByRole('region', { name: 'Sign-in required' })
  await reloadUntil(page, connectionPath, async () => {
    await expect(notice).toBeVisible({ timeout: 1_000 })
  })

  // Another account of the Channel is refused: it would mix two sellers' Orders under one Connection.
  await notice.getByRole('button', { name: 'Sign in again' }).click()
  await expect(page.getByRole('heading', { level: 1, name: `Sign in again to Test OAuth channel: ${name}` })).toBeVisible()
  await fakeOAuth.approve(await shownCode(page), { id: 'another-seller', label: 'another-seller' })
  await expect(page.getByRole('alert').filter({ hasText: 'You signed in as another-seller, a different Test OAuth channel account' })).toBeVisible({
    timeout: 20_000,
  })

  // Same account: the credentials are replaced, no second Connection is made, and it syncs again.
  await page.getByRole('button', { name: 'Try again' }).click()
  await fakeOAuth.approve(await shownCode(page))
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(page).toHaveURL((url) => url.pathname === connectionPath)
  await reloadUntil(page, connectionPath, async () => {
    await expect(page.getByText('Working', { exact: true })).toBeVisible({ timeout: 1_000 })
    await expect(page.getByRole('region', { name: 'Sign-in required' })).toHaveCount(0)
  })
  await page.goto('/connections')
  await expect(page.getByRole('link', { name })).toHaveCount(1)
})

test('a refused sign-in can be tried again, and an open one cancelled', async ({ page, fakeOAuth }) => {
  await signUp(page)
  await fakeOAuth.deny(await startConnecting(page, 'Refused'))
  await expect(page.getByRole('alert').filter({ hasText: 'Access was refused on Test OAuth channel.' })).toBeVisible({ timeout: 20_000 })

  await page.getByRole('button', { name: 'Try again' }).click()
  await shownCode(page)
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'The sign-in was cancelled.' })).toBeVisible()
  await page.goto('/connections')
  await expect(page.getByText('There are no connections yet.', { exact: false })).toBeVisible()
})

test('the sign-in page speaks Polish', async ({ page }) => {
  await signUp(page)
  await page.getByRole('group', { name: 'Language' }).getByRole('button', { name: 'Polski' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Pulpit' })).toBeVisible()
  await page.goto('/connections/new')
  await page.getByRole('link', { name: /Test OAuth channel/ }).click()
  await page.getByLabel('Nazwa', { exact: true }).fill('Konto sprzedawcy')
  await page.getByRole('button', { name: 'Przejdź do logowania' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Zaloguj się do Test OAuth channel' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Twój kod' }).getByText(CODE)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('link', { name: 'Otwórz stronę logowania Test OAuth channel' })).toBeVisible()
})
