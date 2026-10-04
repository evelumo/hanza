import type { AnyConnectorDefinition, CapabilityContext, CapabilityName } from '@hanza/connector-sdk'
import type { SyncStream } from '@hanza/db'
import { openConnection } from '../connections/connections'
import { failSyncRun, startSyncRun } from '../connections/sync-state'
import type { Context } from '../context'
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

  const scope: RunScope = { organizationId, connectionId, stream, run }
  const { cursor } = await startSyncRun(ctx, organizationId, connectionId, stream)
  const built = await runConnectorCall(ctx, scope, async () => buildCapabilityContext(ctx, opened, connector))
  let requests = 0
  const context: CapabilityContext = {
    ...built,
    fetch: (resource, init) => {
      requests++
      return built.fetch(resource, init)
    },
  }
  return { connector, context, scope, cursor, channelRequests: () => requests }
}

/**
 * Error name, Prisma code and the last line of the message: enough to tell what failed. A full
 * Prisma message can quote the query's arguments, which may hold Buyer data.
 */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'Unexpected failure'
  const code = (error as { code?: unknown }).code
  const lines = error.message.split('\n').map((line) => line.trim()).filter(Boolean)
  const detail = (lines.at(-1) ?? '').slice(0, 300)
  return `${error.name}${typeof code === 'string' ? ` ${code}` : ''}${detail ? `: ${detail}` : ''}`
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
