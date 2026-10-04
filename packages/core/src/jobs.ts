import type { z } from 'zod'
import type { Context } from './context'

export interface JobDefinition<TSchema extends z.ZodType = z.ZodType> {
  name: string
  schema: TSchema
  handler: (ctx: Context, payload: z.infer<TSchema>) => Promise<void>
}

export function defineJob<TSchema extends z.ZodType>(job: JobDefinition<TSchema>): JobDefinition<TSchema> {
  return job
}
