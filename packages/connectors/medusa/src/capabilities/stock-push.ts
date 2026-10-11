import { pushRejectionCodeSchema, TransientError, type StockLevel, type StockPushResult } from '@hanza/connector-sdk'
import { z } from 'zod'
import { stockAnswerSchema } from '../api'
import { request } from '../client'
import { readPluginAnswer } from '../plugin'
import type { MedusaContext } from '../settings'

/** The code for a refusal whose code is missing or not a short machine code. */
export const UNKNOWN_REJECTION = 'unknown_error'
export const NOT_CONFIRMED_MESSAGE = 'medusa-plugin-hanza did not confirm every variant of the stock push; it is sent again'

/**
 * One `POST /admin/hanza/stock` with the levels as `{ variant_id, available }`: the plugin sets each variant's
 * availability at the stock location chosen in its settings (`stocked = available + reserved`). Its per-variant
 * results map one to one; never `ended` (Medusa keeps a sold-out variant published). A 409 `stock_location_not_set`
 * fails the whole call (`LOCATION_NOT_SET_MESSAGE`).
 */
export async function pushStock(ctx: MedusaContext, levels: StockLevel[]): Promise<StockPushResult[]> {
  if (levels.length === 0) return []
  // A level given twice counts once, with its last number.
  const byVariant = new Map(levels.map((level) => [level.offerExternalId, level.available]))
  const raw = await request(ctx, {
    method: 'POST',
    path: 'hanza/stock',
    body: { levels: [...byVariant].map(([variant_id, available]) => ({ variant_id, available })) },
    schema: z.unknown(),
    what: 'stock push',
  })
  const { results } = readPluginAnswer(raw, stockAnswerSchema, 'stock push')
  const answered = new Map(results.filter((result) => byVariant.has(result.variant_id)).map((result) => [result.variant_id, result]))
  // A variant the answer leaves out may or may not have been set: no refusal, and not "applied" either.
  if ([...byVariant.keys()].some((id) => !answered.has(id))) throw new TransientError(NOT_CONFIRMED_MESSAGE)
  return [...answered.values()].map((result): StockPushResult => {
    if (result.outcome === 'ok') return { offerExternalId: result.variant_id, outcome: 'ok' }
    const code = pushRejectionCodeSchema.safeParse(result.code)
    return { offerExternalId: result.variant_id, outcome: 'rejected', code: code.success ? code.data : UNKNOWN_REJECTION }
  })
}
