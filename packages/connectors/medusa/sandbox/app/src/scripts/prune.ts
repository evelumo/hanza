import type { ExecArgs, Logger } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

// Prunes the plugin's whole journal (`sandbox.sh prune`), so that a position recorded before it answers 410
// `journal_expired`: the conformance kit's check C18 asks for `after=1`. Run in the medusa container:
//
//   npx medusa exec ./src/scripts/prune.ts
//
// The plugin's retention job prunes by age (whole days); the seed's entries are seconds old, so this asks for "older than
// 0 days", which is everything written so far. `sandbox.sh prune` then touches an order so one entry is left to start from.

interface HanzaService {
  pruneOlderThan(days: number): Promise<{ deleted: number; pruned_through_seq: number }>
}

export default async function prune({ container }: ExecArgs) {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER)
  const hanza = container.resolve("hanza") as HanzaService
  const result = await hanza.pruneOlderThan(0)
  logger.info(`Pruned ${result.deleted} journal entries; pruned through seq ${result.pruned_through_seq}.`)
}
