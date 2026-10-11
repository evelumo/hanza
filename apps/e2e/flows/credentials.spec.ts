import { addFakeConnection, expect, openUserMenu, reloadUntil, signUp, test, waitForSeedOrders } from '../src/fixtures'

test('a Connection whose API key stopped working gets new credentials and syncs again', async ({ page, db }) => {
  const account = await signUp(page)
  const name = 'Shop with a revoked key'
  // The fake Channel refuses this key on every call, as a shop refuses a key that was revoked there.
  const connectionId = await addFakeConnection(page, name, { apiKey: 'expired' })
  const path = `/connections/${connectionId}`
  const notice = page.getByRole('region', { name: 'Sign-in required' })
  const credentials = page.getByRole('region', { name: 'Credentials', exact: true })

  // The first sync is refused: the Connection waits, and its page says what to do about it.
  await reloadUntil(page, path, async () => {
    await expect(notice).toBeVisible({ timeout: 1_000 })
  })
  await expect(notice).toContainText('Test channel no longer accepts the credentials of this connection, so it does not sync. Replace them to resume.')
  await expect(page.getByRole('region', { name: 'Synchronisation' })).toContainText('The API key has expired')
  await expect(page.getByRole('button', { name: 'Sign in again' })).toHaveCount(0)

  // So does the dashboard, with a row that leads to the form...
  await page.goto('/dashboard')
  const waiting = page.getByRole('region', { name: 'Needs attention' }).getByRole('link', { name: new RegExp(`^Connection ${name} needs new credentials`) })
  await expect(waiting).toContainText('It does not sync until someone replaces its credentials.')
  await waiting.click()
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible()
  await expect(page).toHaveURL((url) => url.pathname === path && url.hash === '#credentials')

  // ...and the list of Connections.
  await page.goto('/connections')
  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name, exact: true }) })
  await expect(row).toContainText('Sign-in required again')
  await row.getByRole('link', { name: 'Enter new credentials' }).click()
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible()
  await expect(page).toHaveURL((url) => url.pathname === path && url.hash === '#credentials')

  // On the page the notice leads there too. The form is the create form's credentials part, and shows nothing stored.
  await page.goto(path)
  await notice.getByRole('link', { name: 'Enter new credentials' }).click()
  await expect(page).toHaveURL((url) => url.hash === '#credentials')
  const apiKey = credentials.getByLabel('API key')
  await expect(apiKey).toHaveAttribute('type', 'password')
  await expect(apiKey).toHaveValue('')

  const key = `e2e-api-key-${crypto.randomUUID()}`
  await apiKey.fill(key)
  await credentials.getByRole('button', { name: 'Replace credentials' }).click()
  await expect(credentials.getByRole('status')).toHaveText('Credentials replaced. The connection is synchronising again: refresh the page in a moment.')
  await expect(apiKey).toHaveValue('')

  // Nobody presses "Synchronise now": the Connection resumes on its own and imports what the Channel has.
  await reloadUntil(page, path, async () => {
    await expect(page.getByText('Working', { exact: true })).toBeVisible({ timeout: 1_000 })
    await expect(notice).toHaveCount(0)
  })
  await expect(page.getByRole('region', { name: 'Recent events' })).toContainText('Credentials replaced')
  // The form stays: a key is also rotated while it still works.
  await expect(credentials.getByRole('button', { name: 'Replace credentials' })).toBeVisible()
  expect(await page.content()).not.toContain(key)
  await waitForSeedOrders(page)
  await page.goto('/dashboard')
  await expect(page.getByRole('region', { name: 'Needs attention' }).getByRole('link', { name: /needs new credentials/ })).toHaveCount(0)

  // Stored sealed, and the Event says who replaced them, never what was typed.
  const stored = await db.query<{ credentials: string; version: number }>(
    `SELECT c."credentials", c."credentialsVersion" AS version
     FROM "connection" c JOIN "organization" o ON o.id = c."organizationId" WHERE c.id = $1 AND o.name = $2`,
    [connectionId, account.organization],
  )
  expect(stored.rows).toHaveLength(1)
  expect(stored.rows[0]!.version).toBe(1)
  expect(stored.rows[0]!.credentials).toMatch(/^v1:/)
  expect(stored.rows[0]!.credentials).not.toContain(key)
  const events = await db.query<{ type: string; payload: unknown }>(
    `SELECT e."type", e."payload" FROM "event_log" e JOIN "organization" o ON o.id = e."organizationId" WHERE o.name = $1`,
    [account.organization],
  )
  expect(events.rows.filter((event) => event.type === 'connection.credentials_replaced').map((event) => event.payload)).toEqual([
    { connectorId: 'fake', actor: { type: 'user', userId: expect.any(String) } },
  ])
  expect(JSON.stringify(events.rows)).not.toContain(key)
})

test('the credentials form speaks Polish', async ({ page }) => {
  const account = await signUp(page)
  const connectionId = await addFakeConnection(page, 'Sklep', { apiKey: 'expired' })
  const menu = await openUserMenu(page, account)
  await menu.getByRole('menuitemradio', { name: 'Polski' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Sklep', exact: true })).toBeVisible()

  const notice = page.getByRole('region', { name: 'Wymagane ponowne logowanie' })
  await reloadUntil(page, `/connections/${connectionId}`, async () => {
    await expect(notice).toBeVisible({ timeout: 1_000 })
  })
  await expect(notice).toContainText('Test channel nie akceptuje już danych dostępowych tego połączenia, więc nie jest ono synchronizowane. Zastąp je, aby wznowić.')
  await expect(notice.getByRole('link', { name: 'Podaj nowe dane dostępowe' })).toBeVisible()
  const credentials = page.getByRole('region', { name: 'Dane dostępowe', exact: true })
  await credentials.getByLabel('API key').fill(`e2e-api-key-${crypto.randomUUID()}`)
  await credentials.getByRole('button', { name: 'Zastąp dane dostępowe' }).click()
  await expect(credentials.getByRole('status')).toHaveText('Dane dostępowe zastąpione. Połączenie znów się synchronizuje: odśwież stronę za chwilę.')
  await reloadUntil(page, `/connections/${connectionId}`, async () => {
    await expect(page.getByRole('region', { name: 'Ostatnie zdarzenia' })).toContainText('Zastąpiono dane dostępowe')
    await expect(page.getByText('Działa', { exact: true })).toBeVisible({ timeout: 1_000 })
  })
})
