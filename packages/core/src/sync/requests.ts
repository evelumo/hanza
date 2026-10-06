import type { z } from 'zod'
import type { Actor } from '../actor'
import { afterCommit } from '../after-commit'
import { createConnection } from '../connections/connections'
import type { Context } from '../context'
import { DomainError } from '../errors'
import { coalesceKeys, offersPullRef, pricePushRef, stockPushRef } from '../jobs/refs'

type Issue = { path: string; message: string }

function issues(prefix: string, error: z.ZodError): Issue[] {
  return error.issues.map((issue) => ({ path: [prefix, ...issue.path.map(String)].join('.'), message: issue.message }))
}

/** Validates the settings against the connector, stores the Connection and starts its first sync. */
export async function addConnection(
  ctx: Context,
  organizationId: string,
  input: { connectorId: string; name: string; config: unknown; credentials: unknown },
  actor: Actor,
): Promise<{ connectionId: string }> {
  const connector = ctx.connectors.require(input.connectorId)
  const config = connector.configSchema.safeParse(input.config)
  const credentials = connector.credentialsSchema.safeParse(input.credentials)
  if (!config.success || !credentials.success) {
    throw new DomainError('invalid_config', 'The settings do not match the connector', {
      issues: [
        ...(config.success ? [] : issues('config', config.error)),
        ...(credentials.success ? [] : issues('credentials', credentials.error)),
      ],
    })
  }

  // Parsed values are stored, so schema defaults are applied once and unknown keys are dropped.
  const { connectionId } = await createConnection(
    ctx,
    organizationId,
    {
      connectorId: connector.id,
      name: input.name,
      config: config.data as Record<string, unknown>,
      credentials: credentials.data as Record<string, unknown>,
    },
    actor,
  )
  // The Connection exists now: a failed enqueue must not tell the caller otherwise (a retry would add
  // a duplicate). The tick starts every stream of a never-synced Connection within a minute anyway.
  await afterCommit(ctx, { job: offersPullRef.name, organizationId, connectionId }, () =>
    ctx.queue.enqueue(offersPullRef, { organizationId, connectionId, trigger: 'manual' }, { coalesceKey: coalesceKeys.offersPull(connectionId) }),
  )
  return { connectionId }
}

/** "Synchronise now": runs even for a Connection waiting for sign-in; a success brings it back to ok. */
export async function requestSync(ctx: Context, organizationId: string, connectionId: string): Promise<void> {
  const connection = await ctx.db.connection.findFirst({ where: { id: connectionId, organizationId }, select: { id: true } })
  if (!connection) throw new DomainError('not_found')
  await ctx.queue.enqueue(
    offersPullRef,
    { organizationId, connectionId, trigger: 'manual' },
    { coalesceKey: coalesceKeys.offersPull(connectionId) },
  )
  await ctx.queue.enqueue(stockPushRef, { organizationId, connectionId }, { coalesceKey: coalesceKeys.stockPush(connectionId) })
  await ctx.queue.enqueue(pricePushRef, { organizationId, connectionId }, { coalesceKey: coalesceKeys.pricePush(connectionId) })
}
