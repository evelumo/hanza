import { randomInt, randomUUID } from 'node:crypto'
import type { FakeChannel } from '@hanza/connector-fake'
import { test as base, expect, type Locator, type Page } from '@playwright/test'
import pg from 'pg'
import { readRunEnv } from './run-env'

export { expect }

export interface FakeChannelCalls {
  stockPushes: FakeChannel['stockPushes']
  statusUpdates: FakeChannel['statusUpdates']
}

export interface FakeChannelProbe {
  /** Everything the fake Channel was told since the worker started, by every organization of the run. */
  calls(): Promise<FakeChannelCalls>
}

export interface Account {
  name: string
  email: string
  password: string
  organization: string
}

/** Acts as the person on the fake OAuth Channel's sign-in page, through the probe in the worker. */
export interface FakeOAuthProbe {
  /** Approves a pending sign-in code, as the default account unless another is given. */
  approve(userCode: string, account?: { id: string; label: string }): Promise<void>
  deny(userCode: string): Promise<void>
  /** Every token issued so far stops working, refresh tokens included (the seller unlinked the application). */
  revokeAll(): Promise<void>
}

export const test = base.extend<{ fakeChannel: FakeChannelProbe; fakeOAuth: FakeOAuthProbe }, { db: pg.Pool }>({
  fakeChannel: async ({}, use) => {
    const url = `${readRunEnv('probeUrl')}/fake-channel`
    await use({
      async calls() {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`fake Channel probe answered ${response.status}`)
        return (await response.json()) as FakeChannelCalls
      },
    })
  },
  fakeOAuth: async ({}, use) => {
    const post = async (path: string, body?: unknown) => {
      const response = await fetch(`${readRunEnv('probeUrl')}${path}`, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
      if (!response.ok) throw new Error(`fake OAuth probe answered ${response.status}: ${await response.text()}`)
    }
    await use({
      approve: (userCode, account) => post('/fake-oauth/approve', { userCode, account }),
      deny: (userCode) => post('/fake-oauth/deny', { userCode }),
      revokeAll: () => post('/fake-oauth/revoke'),
    })
  },
  // For assertions the panel does not show; the run's own throwaway database.
  db: [
    async ({}, use) => {
      const pool = new pg.Pool({ connectionString: readRunEnv('databaseUrl'), max: 2 })
      await use(pool)
      await pool.end()
    },
    { scope: 'worker' },
  ],
})

function newAccount(): Account {
  const id = randomUUID().slice(0, 8)
  return {
    name: `E2E User ${id}`,
    email: `e2e-${id}@example.test`,
    password: `e2e-password-${id}`,
    organization: `E2E Company ${id}`,
  }
}

// An address from 198.18.0.0/15 (reserved for benchmarking), new for every account.
const clientAddress = () => `198.18.${randomInt(256)}.${randomInt(1, 255)}`

/**
 * A new user with their organization, created through the Better Auth API (the endpoints the
 * panel's forms call) in the page's browser session, which ends signed in on the dashboard.
 * Better Auth allows 3 sign-ups and sign-ins per 10 s per client address, and every flow comes
 * from 127.0.0.1; each account gets its own address in X-Forwarded-For, which Better Auth reads
 * (a single value is trusted) and `next start` passes on. Only `auth.spec.ts` uses the forms.
 */
export async function signUp(page: Page): Promise<Account> {
  const account = newAccount()
  const headers = { origin: readRunEnv('baseUrl'), 'x-forwarded-for': clientAddress() }
  const signedUp = await page.request.post('/api/auth/sign-up/email', {
    headers,
    data: { name: account.name, email: account.email, password: account.password },
  })
  expect(signedUp.status(), await signedUp.text()).toBe(200)
  const slug = account.organization.toLowerCase().replaceAll(' ', '-')
  // Like the onboarding form: creating the organization makes it the session's active one.
  const created = await page.request.post('/api/auth/organization/create', { headers, data: { name: account.organization, slug } })
  expect(created.status(), await created.text()).toBe(200)
  await page.goto('/dashboard')
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
  return account
}

/** Like `signUp`, but through the register and onboarding forms; three of these in 10 s hit the rate limit. */
export async function signUpThroughForms(page: Page): Promise<Account> {
  const account = newAccount()
  await page.goto('/register')
  await page.getByLabel('Full name').fill(account.name)
  await page.getByLabel('Email').fill(account.email)
  await page.getByLabel('Password').fill(account.password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('heading', { name: 'Add your company' })).toBeVisible()
  await page.getByLabel('Company name').fill(account.organization)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  return account
}

/** The sidebar's navigation. A page below a list repeats the list's name as a link in the breadcrumb, so navigate through this. */
export function mainNavigation(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Main navigation' })
}

/**
 * A destination in the sidebar by its name. "Orders" and "Offers" carry a count once something waits behind
 * them, and the count is part of the link's name ("Orders, 3 need attention"); this finds the link either way.
 */
export function navLink(page: Page, name: string): Locator {
  return mainNavigation(page).getByRole('link', { name: new RegExp(`^${name}(,|$)`) })
}

/** The command palette, opened with the banner's "Search" button; its `combobox` is the search field. */
export async function openCommandPalette(page: Page): Promise<Locator> {
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await page.getByRole('banner').getByRole('button', { name: 'Search' }).click()
  await expect(palette.getByRole('combobox')).toBeFocused()
  return palette
}

/**
 * The button that moves an Order on to its next phase ("Change to: Processing", then "Change to: Shipped"): the
 * page's primary action, in its header. Every other change of status is in the "Status" section.
 */
export function orderPrimaryAction(page: Page, name: string): Locator {
  return page.getByRole('main').getByRole('button', { name, exact: true })
}

/**
 * Opens the user menu at the foot of the sidebar and returns it: the language and theme (radio items) and
 * "Sign out". Its button is named "<name>, <email>" in every language (the avatar's initial is not part of it).
 */
export async function openUserMenu(page: Page, account: Account): Promise<Locator> {
  await page.getByRole('button', { name: account.email }).click()
  const menu = page.getByRole('menu', { name: account.email })
  await expect(menu).toBeVisible()
  return menu
}

/**
 * The dialog that asks before a form with a consequence is sent (shipping or cancelling an Order, a delete, an
 * erasure). It is named after the button that opened it and holds "Cancel" and a button with that same name.
 */
export function confirmation(page: Page, name: string): Locator {
  return page.getByRole('alertdialog', { name, exact: true })
}

/**
 * Adds a Connection with the fake connector (its first sync starts on its own) under its own seller account (a fresh
 * API key), so pushes of other flows never end its Offers; returns its id. `rejectOffers` lists
 * fake Offer ids whose stock and price this Connection's Channel refuses (per Connection, so flows never share it).
 */
export async function addFakeConnection(page: Page, name = 'Fake marketplace', options: { rejectOffers?: string } = {}): Promise<string> {
  await page.goto('/connections/new')
  await page.getByRole('link', { name: /Test channel/ }).click()
  await page.getByLabel('Name', { exact: true }).fill(name)
  if (options.rejectOffers) await page.getByLabel(/Offers that refuse stock and prices/).fill(options.rejectOffers)
  // Its own key, i.e. its own seller account: the fake Channel keeps what pushes did to Offers per account.
  await page.getByLabel('API key').fill(`e2e-api-key-${crypto.randomUUID()}`)
  await page.getByRole('button', { name: 'Add connection' }).click()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
  const id = new URL(page.url()).pathname.split('/').pop()
  if (!id) throw new Error(`No Connection id in ${page.url()}`)
  return id
}

/**
 * Reloads `path` until `ready` passes: for results of background jobs, which the panel
 * shows on the next page load.
 */
export async function reloadUntil(page: Page, path: string, ready: () => Promise<void>, timeout = 30_000): Promise<void> {
  await expect(async () => {
    await page.goto(path)
    await ready()
  }).toPass({ timeout, intervals: [500, 1_000, 2_000] })
}

/** Waits until the first sync of a fake Connection has imported the four seed Orders. */
export async function waitForSeedOrders(page: Page): Promise<void> {
  await reloadUntil(page, '/orders', async () => {
    for (const number of ['fake-order-1', 'fake-order-2', 'fake-order-3', 'fake-order-4']) {
      await expect(page.getByRole('link', { name: number, exact: true })).toBeVisible({ timeout: 1_000 })
    }
  })
}
