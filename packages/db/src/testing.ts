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

/** A throwaway database with every migration applied, created on the server `adminUrl` points to. */
export async function createTestDatabase(adminUrl: string): Promise<{ url: string; drop(): Promise<void> }> {
  const name = `hanza_test_${process.pid}_${randomBytes(4).toString('hex')}`
  await withClient(adminUrl, (client) => client.query(`CREATE DATABASE "${name}"`))
  const url = withDatabase(adminUrl, name)

  const drop = async () => {
    await withClient(adminUrl, async (client) => {
      await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [name])
      await client.query(`DROP DATABASE IF EXISTS "${name}"`)
    })
  }

  try {
    const migrations = (await readdir(MIGRATIONS_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
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
