import { randomBytes } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'prisma', 'migrations')
const UNREACHABLE = 'Start Postgres with `pnpm infra:up` or unset HANZA_TEST_DATABASE_URL'

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${database}`
  return parsed.toString()
}

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/** Every migration, in the order they are applied. */
export async function migrationNames(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

/** Applies one migration to the database `url` points to, as `createTestDatabase` does. */
export async function applyMigration(url: string, migration: string): Promise<void> {
  if (!(await migrationNames()).includes(migration)) throw new Error(`Unknown migration ${migration}`)
  await withClient(url, async (client) => {
    await client.query(await readFile(join(MIGRATIONS_DIR, migration, 'migration.sql'), 'utf8'))
  })
}

const TEST_DATABASE_NAME = /^hanza_(test|e2e)_[a-z0-9_]{1,40}$/

/** Ends its sessions and drops it; only a name of the throwaway-database form is accepted. */
export async function dropTestDatabase(adminUrl: string, name: string): Promise<void> {
  if (!TEST_DATABASE_NAME.test(name)) throw new Error(`Refusing to drop "${name}": not a throwaway test database name`)
  await withClient(adminUrl, async (client) => {
    await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [name])
    await client.query(`DROP DATABASE IF EXISTS "${name}"`)
  })
}

/**
 * A throwaway database with every migration applied (or only those before `options.before`, to test a data
 * migration against rows shaped like the previous schema), created on the server `adminUrl` points to.
 * `name` (default `hanza_test_<pid>_<random>`) lets a caller record it before it exists.
 */
export async function createTestDatabase(
  adminUrl: string,
  options: { name?: string; before?: string } = {},
): Promise<{ url: string; drop(): Promise<void> }> {
  const name = options.name ?? `hanza_test_${process.pid}_${randomBytes(4).toString('hex')}`
  if (!TEST_DATABASE_NAME.test(name)) throw new Error(`"${name}" is not a throwaway test database name`)
  await withClient(adminUrl, (client) => client.query(`CREATE DATABASE "${name}"`))
  const url = withDatabase(adminUrl, name)

  const drop = () => dropTestDatabase(adminUrl, name)

  try {
    const all = await migrationNames()
    if (options.before && !all.includes(options.before)) throw new Error(`Unknown migration ${options.before}`)
    const migrations = options.before ? all.filter((name) => name < options.before!) : all
    await withClient(url, async (client) => {
      for (const migration of migrations) {
        await client.query(await readFile(join(MIGRATIONS_DIR, migration, 'migration.sql'), 'utf8'))
      }
    })
  } catch (error) {
    await drop()
    throw error
  }
  return { url, drop }
}

let current: { drop(): Promise<void> } | undefined

/** Vitest global setup: provides the URL of a fresh test database, or null when HANZA_TEST_DATABASE_URL is unset. */
export async function setup(project: { provide(key: 'hanzaTestDatabaseUrl', value: string | null): void }): Promise<void> {
  const adminUrl = process.env.HANZA_TEST_DATABASE_URL
  if (!adminUrl) {
    project.provide('hanzaTestDatabaseUrl', null)
    return
  }
  try {
    await withClient(adminUrl, (client) => client.query('SELECT 1'))
  } catch (error) {
    throw new Error(UNREACHABLE, { cause: error })
  }
  const database = await createTestDatabase(adminUrl)
  current = database
  project.provide('hanzaTestDatabaseUrl', database.url)
}

export async function teardown(): Promise<void> {
  await current?.drop()
  current = undefined
}
