import { createDb, type Db } from '@hanza/db'
import { loadEnv, type Env } from './env'
import { createLogger, type Logger } from './logger'
import { createJobQueue, type JobQueue } from './queue'

/**
 * Everything a command, job or route needs. Built once per process by
 * `createContext()` — no DI container, dependencies are passed explicitly.
 */
export interface Context {
  env: Env
  db: Db
  queue: JobQueue
  log: Logger
}

export function createContext(scope: string, env: Env = loadEnv()): Context {
  return {
    env,
    db: createDb(env.DATABASE_URL),
    queue: createJobQueue(env.REDIS_URL),
    log: createLogger(scope),
  }
}

export async function closeContext(ctx: Context): Promise<void> {
  await ctx.queue.close()
  await ctx.db.$disconnect()
}
