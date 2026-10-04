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
