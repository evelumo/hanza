import type { Context } from './context'

/**
 * Runs follow-up work (an enqueue, a rematch) once the transaction has
 * committed. The change is durable by then, so a failure here must not fail
 * the operation: the caller would see an error and its retry would hit
 * `sku_taken` or `invalid_transition`. It is logged instead; every call site
 * names how the skipped work is recovered. `fields` must hold ids only.
 */
export async function afterCommit(ctx: Pick<Context, 'log'>, fields: Record<string, string>, work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch (error) {
    ctx.log.error('post-commit step failed', { ...fields, error: error instanceof Error ? error.message : String(error) })
  }
}
