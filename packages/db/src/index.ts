import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient, type Prisma } from './generated/prisma/client'

export type Db = PrismaClient
export type Tx = Prisma.TransactionClient

const UTC_SESSION = '-c TimeZone=UTC'

/**
 * `connectionString` with the session's time zone pinned to UTC. Every `DateTime` column is a `timestamp` without a
 * zone holding UTC, and the driver reads `now()` by dropping its offset: in a session whose zone is not UTC (the
 * server's default on a machine set to local time, or the database's or the role's), `now()` read through Prisma is
 * off by the offset, and a time written by Prisma is compared with SQL's `now()` as if it were local. A startup
 * option beats the server's, the database's and the role's default, and the last one in the list beats any the
 * connection string already carries.
 */
export function withUtcSession(connectionString: string): string {
  const url = new URL(connectionString)
  const options = url.searchParams.get('options')
  url.searchParams.set('options', options ? `${options} ${UTC_SESSION}` : UTC_SESSION)
  return url.toString()
}

/** The only way a Prisma client is made: its sessions run in UTC (see `withUtcSession`). */
export function createDb(connectionString: string): Db {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: withUtcSession(connectionString) }) })
}

export { Prisma } from './generated/prisma/client'
export type * from './generated/prisma/client'
