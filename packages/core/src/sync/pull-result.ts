import { z } from 'zod'

/** Connector output is validated like any external data; a `ZodError` here is classified `permanent`. */
export function pullResultSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable(), hasMore: z.boolean() })
}
