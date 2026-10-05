import type { Db, Tx } from '@hanza/db'
import { z } from 'zod'
import { getAvailability } from './availability'
import { channelWarehouseIds } from './warehouse'

const units = z.number().int().min(0).max(1_000_000)

/** A Channel Connection's Safety buffer and Channel limit (null: no limit). */
export const channelStockRulesSchema = z.object({
  safetyBuffer: units,
  channelLimit: units.nullable(),
})

export type ChannelStockRules = z.infer<typeof channelStockRulesSchema>

export const NO_CHANNEL_STOCK_RULES: ChannelStockRules = { safetyBuffer: 0, channelLimit: null }

const isUnits = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0

/**
 * Channel Available: Available less the Safety buffer, at most the Channel limit, never below zero.
 * The one definition of the number a Channel is told (ADR 0011). It fails closed: a setting or an
 * Available that is not a whole number in range (which the schema and the database CHECKs should
 * make impossible) tells the Channel 0 rather than guess, so the result stays within 0..max(0, Available).
 */
export function channelAvailable(available: number, rules: ChannelStockRules): number {
  if (!Number.isInteger(available) || !isUnits(rules.safetyBuffer)) return 0
  if (rules.channelLimit !== null && !isUnits(rules.channelLimit)) return 0
  return Math.max(0, Math.min(available - rules.safetyBuffer, rules.channelLimit ?? Infinity))
}

/**
 * Channel Available of these Products for one Connection: `channelAvailable` of the Available of the
 * Channel's Warehouses only (ADR 0013); Products not found, or a Channel left with no Warehouse,
 * count as Available 0. Read the Offers' push sequence before calling this: a rule, Warehouse choice
 * or stock change after that read bumps the sequence and keeps the Offer pending (ADR 0010).
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
  const warehouseIds = await channelWarehouseIds(client, organizationId, connectionId)
  const availability = await getAvailability(client, organizationId, productIds, warehouseIds)
  for (const productId of new Set(productIds)) {
    result.set(productId, channelAvailable(availability.get(productId)?.available ?? 0, connection))
  }
  return result
}
