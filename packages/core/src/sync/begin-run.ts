import type { AnyConnectorDefinition, CapabilityContext, CapabilityName } from '@hanza/connector-sdk'
import type { SyncStream } from '@hanza/db'
import { openConnection } from '../connections/connections'
import { canRefresh, needsRefresh, parseCredentials, refreshCredentials } from '../connections/credentials'
import { failSyncRun, startSyncRun } from '../connections/sync-state'
import type { Context } from '../context'
import { describeFailure } from '../describe-failure'
import type { JobRunInfo } from '../jobs'
import { buildCapabilityContext } from './capability-context'
import { isRecordedFailure, runConnectorCall, type RunScope } from './run-connector'

export interface SyncRun {
  connector: AnyConnectorDefinition
  context: CapabilityContext
  scope: RunScope
  /** The persisted cursor (only `orders_pull` keeps one). */
  cursor: string | null
  /** Requests the connector made through `context.fetch` so far: 0 means the Channel was not contacted. */
  channelRequests(): number
}

type SyncRunInput = { organizationId: string; connectionId: string; stream: SyncStream; capability: CapabilityName; run: JobRunInfo }

/**
 * Opens the Connection and starts a run of `stream`. Returns null, doing nothing, when the
 * Connection does not exist in this organization, its connector is not registered, or the
 * connector lacks `capability`, so a payload with a foreign `organizationId` is harmless.
 */
async function beginSyncRun(ctx: Context, input: SyncRunInput): Promise<SyncRun | null> {
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

  const baseScope: RunScope = { organizationId, connectionId, stream, run }
  const { cursor } = await startSyncRun(ctx, organizationId, connectionId, stream)
  const built = await runConnectorCall(ctx, baseScope, async () => buildCapabilityContext(ctx, opened, connector))
  let requests = 0
  const context: CapabilityContext = {
    ...built,
    fetch: (resource, init) => {
      requests++
      return built.fetch(resource, init)
    },
  }

  // Token lifetime is the core's (ADR 0020): refresh ahead of expiry, and once after the Channel refuses the token.
  let version = opened.credentialsVersion
  const renew = async (force: boolean) => {
    const current = await refreshCredentials(ctx, { organizationId, connectionId, connector, app: context.app, seenVersion: version, force })
    if (!current) return false
    // In place: capabilities get this object, so a retried call uses the new credentials.
    context.credentials = parseCredentials(connector, current.credentials)
    version = current.version
    return true
  }
  if (needsRefresh(connector, context.credentials, new Date())) {
    await runConnectorCall(ctx, baseScope, () => renew(false))
  }
  const scope: RunScope = canRefresh(connector) ? { ...baseScope, reauthorize: () => renew(true) } : baseScope
  return { connector, context, scope, cursor, channelRequests: () => requests }
}

/**
 * Runs a sync job's body for one Connection stream. Connector calls record their own failures
 * (`runConnectorCall`); any other failure (decrypting credentials, importing, saving the cursor,
 * the follow-up rematch) is recorded here as `transient`, health `failing` on the last attempt,
 * then rethrown for the queue to retry. So no run fails without showing in its sync state.
 */
export async function withSyncRun(ctx: Context, input: SyncRunInput, body: (sync: SyncRun) => Promise<void>): Promise<void> {
  const { organizationId, connectionId, stream, run } = input
  try {
    const sync = await beginSyncRun(ctx, input)
    if (sync) await body(sync)
  } catch (error) {
    if (!isRecordedFailure(error)) {
      const message = describeFailure(error)
      ctx.log.error('sync run failed', { organizationId, connectionId, stream, attempt: run.attempt, error: message })
      try {
        await failSyncRun(ctx, organizationId, connectionId, stream, {
          kind: 'transient',
          message,
          health: run.attempt >= run.maxAttempts ? 'failing' : null,
        })
      } catch (recordError) {
        // E.g. the database is down; the queue still retries the run.
        ctx.log.error('sync failure not recorded', { organizationId, connectionId, stream, error: describeFailure(recordError) })
      }
    }
    throw error
  }
}
