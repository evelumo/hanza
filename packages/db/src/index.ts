import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient, type Prisma } from './generated/prisma/client'

export type Db = PrismaClient
export type Tx = Prisma.TransactionClient

export function createDb(connectionString: string): Db {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
}

export { Prisma } from './generated/prisma/client'
export type * from './generated/prisma/client'
