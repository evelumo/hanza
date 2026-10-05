import { randomUUID } from 'node:crypto'
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

export const test = base.extend<{ fakeChannel: FakeChannelProbe }, { db: pg.Pool }>({
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

/**
 * Clicks `button`, which posts to the Better Auth endpoint `path`. Better Auth allows 3 sign-ins
 * and sign-ups per 10 s from one IP, and every flow comes from 127.0.0.1: on a 429 this waits as
 * long as the server asks and submits again, so the limit stays on and the flows stay independent.
 */
export async function submitAuthForm(page: Page, button: Locator, path: '/api/auth/sign-up/email' | '/api/auth/sign-in/email'): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const response = page.waitForResponse((candidate) => new URL(candidate.url()).pathname === path && candidate.request().method() === 'POST')
    await button.click()
    const answer = await response
    if (answer.status() !== 429 || attempt === 5) return
    const seconds = Number(answer.headers()['x-retry-after']) || 10
    await page.waitForTimeout(seconds * 1_000 + 250)
  }
}

/** Registers a new user and creates their organization through the panel; ends on the dashboard. */
export async function signUp(page: Page): Promise<Account> {
  const id = randomUUID().slice(0, 8)
  const account: Account = {
    name: `E2E User ${id}`,
    email: `e2e-${id}@example.test`,
    password: `e2e-password-${id}`,
    organization: `E2E Company ${id}`,
  }
  await page.goto('/register')
  await page.getByLabel('Full name').fill(account.name)
  await page.getByLabel('Email').fill(account.email)
  await page.getByLabel('Password').fill(account.password)
  await submitAuthForm(page, page.getByRole('button', { name: 'Create account' }), '/api/auth/sign-up/email')
  await expect(page.getByRole('heading', { name: 'Add your company' })).toBeVisible()
  await page.getByLabel('Company name').fill(account.organization)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  return account
}

/** Adds a Connection with the fake connector (its first sync starts on its own); returns its id. */
export async function addFakeConnection(page: Page, name = 'Fake marketplace'): Promise<string> {
  await page.goto('/connections/new')
  await page.getByRole('link', { name: /Test channel/ }).click()
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByLabel('API key').fill('e2e-api-key')
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
