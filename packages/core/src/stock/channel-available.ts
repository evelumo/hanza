import type { Db, Tx } from '@hanza/db'
import { z } from 'zod'
import { getAvailability } from './availability'

const units = z.number().int().min(0).max(1_000_000)

/** A Channel Connection's Safety buffer and Channel limit (null: no limit). */
export const channelStockRulesSchema = z.object({
  safetyBuffer: units,
  channelLimit: units.nullable(),
})

export type ChannelStockRules = z.infer<typeof channelStockRulesSchema>

export const NO_CHANNEL_STOCK_RULES: ChannelStockRules = { safetyBuffer: 0, channelLimit: null }

/**
 * Channel Available: Available less the Safety buffer, at most the Channel limit, never below zero.
 * The one definition of the number a Channel is told (ADR 0011). Settings outside their range are
 * read as "no buffer" / "no limit", so the result always stays within 0..max(0, Available).
 */
export function channelAvailable(available: number, rules: ChannelStockRules): number {
  const buffer = Number.isInteger(rules.safetyBuffer) && rules.safetyBuffer > 0 ? rules.safetyBuffer : 0
  const limit = rules.channelLimit !== null && Number.isInteger(rules.channelLimit) && rules.channelLimit >= 0 ? rules.channelLimit : Infinity
  return Math.max(0, Math.min(available - buffer, limit))
}

/**
 * Channel Available of these Products for one Connection; Products not found count as Available 0.
 * Read the Offers' push sequence before calling this: a rule or stock change after that read bumps
 * the sequence and keeps the Offer pending (ADR 0010). Multiple Warehouses (#4) extend this function.
 */
export async function getChannelAvailability(
  db: Db | Tx,
  organizationId: string,
  connectionId: string,
  productIds: string[],
): Promise<Map<string, number>> {
  const client: Tx = db
  const connection = await client.connection.findFirst({
    where: { id: connectionId, organizationId },
    select: { safetyBuffer: true, channelLimit: true },
  })
  const result = new Map<string, number>()
  if (!connection) return result
  const availability = await getAvailability(client, organizationId, productIds)
  for (const productId of new Set(productIds)) {
    result.set(productId, channelAvailable(availability.get(productId)?.available ?? 0, connection))
  }
  return result
}
