import { deviceFlowOf } from '@hanza/connector-sdk'
import type { Actor } from '../actor'
import { afterCommit } from '../after-commit'
import type { Context } from '../context'
import { DomainError } from '../errors'
import { appendEvent } from '../events'
import { enqueueSync } from '../sync/requests'
import { CREDENTIALS_WRITE_TX_OPTIONS, credentialsExpiry, hasCredentialsForm, lockCredentials } from './credentials'
import { setHealth } from './sync-state'

/**
 * Gives a Connection new credentials typed by a person (a rotated or revoked API key). Only for a connector whose
 * credentials come from a form (`hasCredentialsForm`); one with a device flow signs in again instead. The
 * Connection's config is not touched, which is what keeps it the same Channel: its Offers, its Orders and the Order
 * feed's position stay.
 *
 * The write takes the lock every other write of the credentials takes (a refresh, a sign-in; ADR 0020) and bumps
 * their version, so writers never interleave and a refresh that read the old ones does not write over the new. A
 * run does not hold that lock while it calls the Channel: it read the whole sealed value in one statement, so it
 * finishes with the credentials it started with, never with a mix. If the Channel refuses those after this write,
 * that run still records `auth_expired`; the streams enqueued below run after it (the queue starts a coalesced job
 * after the one in flight) and their success clears it.
 *
 * Health goes back to `unknown`, as after "Sign in again": nothing has proved the new credentials yet, and the tick
 * skips only `auth_expired`. The streams are enqueued at once; a lost enqueue is recovered by the tick, which starts
 * each stream when it is next due.
 *
 * Nothing is asked of the Channel here (the SDK has no hook to check credentials), so a wrong key is stored and the
 * run that follows says so. The Event names who did it, never what was typed.
 */
export async function replaceCredentials(
  ctx: Context,
  organizationId: string,
  connectionId: string,
  credentials: unknown,
  actor: Actor,
): Promise<void> {
  const connection = await ctx.db.connection.findFirst({ where: { id: connectionId, organizationId }, select: { connectorId: true } })
  if (!connection) throw new DomainError('not_found')
  const connector = ctx.connectors.requireConfigured(connection.connectorId)
  if (deviceFlowOf(connector)) throw new DomainError('sign_in_required')
  if (!hasCredentialsForm(connector)) throw new DomainError('no_credentials')
  const parsed = connector.credentialsSchema.safeParse(credentials)
  if (!parsed.success) {
    throw new DomainError('invalid_config', 'The credentials do not match the connector', {
      // Paths only: an issue's message could echo what was typed.
      issues: parsed.error.issues.map((issue) => ({ path: ['credentials', ...issue.path.map(String)].join('.') })),
    })
  }

  // Parsed values are stored, so schema defaults are applied once and unknown keys are dropped, as in addConnection.
  const sealed = ctx.secrets.seal(JSON.stringify(parsed.data), organizationId)
  await ctx.db.$transaction(async (tx) => {
    await lockCredentials(tx, connectionId)
    const written = await tx.connection.updateMany({
      where: { id: connectionId, organizationId },
      data: { credentials: sealed, credentialsVersion: { increment: 1 }, credentialsExpireAt: credentialsExpiry(connector, parsed.data) },
    })
    if (written.count !== 1) throw new DomainError('not_found')
    await appendEvent(tx, {
      organizationId,
      type: 'connection.credentials_replaced',
      subject: { type: 'connection', id: connectionId },
      payload: { connectorId: connector.id, actor },
    })
    await setHealth(tx, organizationId, connectionId, 'unknown', null)
  }, CREDENTIALS_WRITE_TX_OPTIONS)
  ctx.log.info('credentials replaced', { organizationId, connectionId, connectorId: connector.id })

  // A lost enqueue: health no longer stops the tick, which starts each stream once it is due again.
  await afterCommit(ctx, { job: 'sync', organizationId, connectionId }, () => enqueueSync(ctx, organizationId, connectionId))
}
