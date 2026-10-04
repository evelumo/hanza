import type { AnyConnectorDefinition, CapabilityContext, CapabilityName } from '@hanza/connector-sdk'
import type { SyncStream } from '@hanza/db'
import { openConnection } from '../connections/connections'
import { startSyncRun } from '../connections/sync-state'
import type { Context } from '../context'
import type { JobRunInfo } from '../jobs'
import { buildCapabilityContext } from './capability-context'
import { runConnectorCall, type RunScope } from './run-connector'

export interface SyncRun {
  connector: AnyConnectorDefinition
  context: CapabilityContext
  scope: RunScope
  /** The persisted cursor (only `orders_pull` keeps one). */
  cursor: string | null
}

/**
 * Opens the Connection and starts a run of `stream`. Returns null, doing nothing, when the
 * Connection does not exist in this organization, its connector is not registered, or the
 * connector lacks `capability`, so a payload with a foreign `organizationId` is harmless.
 */
export async function beginSyncRun(
  ctx: Context,
  input: { organizationId: string; connectionId: string; stream: SyncStream; capability: CapabilityName; run: JobRunInfo },
): Promise<SyncRun | null> {
  const { organizationId, connectionId, stream, capability, run } = input
  const opened = await openConnection(ctx, organizationId, connectionId)
  if (!opened) {
    ctx.log.info('sync skipped: no such Connection', { organizationId, connectionId, stream })
    return null
  }
  const connector = ctx.connectors.get(opened.connectorId)
  if (!connector) {
    ctx.log.error('sync skipped: connector not registered', { organizationId, connectionId, connectorId: opened.connectorId, stream })
    return null
  }
  if (!connector.capabilities[capability]) return null

  const scope: RunScope = { organizationId, connectionId, stream, run }
  const { cursor } = await startSyncRun(ctx, organizationId, connectionId, stream)
  const context = await runConnectorCall(ctx, scope, async () => buildCapabilityContext(ctx, opened, connector))
  return { connector, context, scope, cursor }
}
