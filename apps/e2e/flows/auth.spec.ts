import { expect, signUp, submitAuthForm, test } from '../src/fixtures'

test('a new user signs up, creates an organization, signs out and signs in again', async ({ page }) => {
  const account = await signUp(page)
  const header = page.getByRole('banner')
  await expect(header).toContainText(account.organization)
  await expect(header).toContainText(account.email)

  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await page.goto('/orders')
  await expect(page).toHaveURL(/\/login$/)

  await page.getByLabel('Email').fill(account.email)
  const signIn = page.getByRole('button', { name: 'Sign in' })
  await page.getByLabel('Password').fill('not-the-password')
  await submitAuthForm(page, signIn, '/api/auth/sign-in/email')
  await expect(page.getByRole('alert').filter({ hasText: 'Invalid email or password.' })).toBeVisible()

  await page.getByLabel('Password').fill(account.password)
  await submitAuthForm(page, signIn, '/api/auth/sign-in/email')
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await expect(header).toContainText(account.organization)
})
