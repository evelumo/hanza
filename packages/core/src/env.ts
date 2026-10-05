import { z } from 'zod'

const envSchema = z.object({
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  HANZA_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'must be base64 of exactly 32 bytes'),
})

export type Env = z.infer<typeof envSchema>

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}

const workerEnvSchema = z.object({
  // A typo must stop the worker at start: Number('ten') is NaN, which BullMQ would not reject.
  WORKER_CONCURRENCY: z
    .string()
    .regex(/^[1-9]\d*$/, 'must be a positive integer')
    .transform(Number)
    .refine(Number.isSafeInteger, 'must be a positive integer')
    .default(10),
})

export type WorkerEnv = z.infer<typeof workerEnvSchema>

/** Settings only the worker reads; separate so an invalid value never breaks the web app. */
export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const parsed = workerEnvSchema.safeParse(source)
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}
