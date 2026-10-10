import { expect, openUserMenu, signUpThroughForms, test } from '../src/fixtures'

// The one flow through the real register, onboarding and sign-in forms. It makes exactly 3
// sign-up/sign-in requests from 127.0.0.1, Better Auth's limit per 10 s; do not add a fourth.
test('a new user signs up, creates an organization, signs out and signs in again', async ({ page }) => {
  const account = await signUpThroughForms(page)
  // The sidebar says whose panel this is: the organization at its head, the account on the user menu's button.
  const organization = page.getByText(account.organization, { exact: true })
  await expect(organization).toBeVisible()
  // Named by the person, not by the initial in the avatar beside the name.
  await expect(page.getByRole('button', { name: account.email })).toHaveAccessibleName(`${account.name}, ${account.email}`)

  const menu = await openUserMenu(page, account)
  await menu.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await page.goto('/orders')
  await expect(page).toHaveURL(/\/login$/)

  const signIn = page.getByRole('button', { name: 'Sign in' })
  await page.getByLabel('Email').fill(account.email)
  await page.getByLabel('Password').fill('not-the-password')
  await signIn.click()
  await expect(page.getByRole('alert').filter({ hasText: 'Invalid email or password.' })).toBeVisible()

  await page.getByLabel('Password').fill(account.password)
  await signIn.click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await expect(organization).toBeVisible()
  await expect(page.getByRole('button', { name: account.email })).toBeVisible()
})
