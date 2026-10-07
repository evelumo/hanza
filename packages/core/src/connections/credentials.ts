import { PermanentError, type AnyConnectorDefinition } from '@hanza/connector-sdk'
import type { Prisma, Tx } from '@hanza/db'
import type { z } from 'zod'
import type { Context } from '../context'
import { buildAuthContext } from '../sync/auth-context'

/** Refresh when the access token expires within this (ADR 0020). */
export const REFRESH_MARGIN_MS = 15 * 60_000

// The refresh request runs inside the transaction that holds the lock (bounded by the 30 s fetch timeout).
export const REFRESH_TX_OPTIONS = { timeout: 45_000, maxWait: 10_000 } as const
/**
 * For any other write of a Connection's credentials (a sign-in): it may wait for the lock as long as a refresh can
 * hold it (its whole transaction), and still has time for its own writes. A shorter timeout would fail an approved
 * sign-in whenever a slow refresh of the same Connection is in flight.
 */
export const CREDENTIALS_WRITE_TX_OPTIONS = { timeout: REFRESH_TX_OPTIONS.timeout + 15_000, maxWait: 10_000 } as const

function issuePaths(prefix: string, error: z.ZodError): string {
  return error.issues.map((issue) => [prefix, ...issue.path.map(String)].join('.')).join(', ')
}

/** Parses stored or refreshed credentials; `PermanentError` with paths only, since a message could echo a token. */
export function parseCredentials(connector: AnyConnectorDefinition, credentials: unknown): unknown {
  const parsed = connector.credentialsSchema.safeParse(credentials)
  if (!parsed.success) {
    throw new PermanentError(`The Connection's credentials do not match connector "${connector.id}": ${issuePaths('credentials', parsed.error)}`)
  }
  return parsed.data
}

export function parseConfig(connector: AnyConnectorDefinition, config: unknown): unknown {
  const parsed = connector.configSchema.safeParse(config)
  if (!parsed.success) {
    throw new PermanentError(`The Connection's settings do not match connector "${connector.id}": ${issuePaths('config', parsed.error)}`)
  }
  return parsed.data
}

/** When the access token in `credentials` expires, as the connector reports it; null when it cannot tell. */
export function credentialsExpiry(connector: AnyConnectorDefinition, credentials: unknown): Date | null {
  if (connector.auth.type !== 'oauth2' || !connector.auth.expiresAt) return null
  let value: string | null
  try {
    value = connector.auth.expiresAt(credentials)
  } catch {
    return null
  }
  if (value === null) return null
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : new Date(time)
}

/**
 * True when the connector can refresh and the access token expires within the margin. Unknown expiry: no proactive
 * refresh. A Channel whose tokens live 15 minutes or less is refreshed before every run: correct (the lock keeps it to
 * one refresh at a time), but one token request per run; lower REFRESH_MARGIN_MS per connector if such a Channel comes.
 */
export function needsRefresh(connector: AnyConnectorDefinition, credentials: unknown, now: Date): boolean {
  if (connector.auth.type !== 'oauth2' || !connector.auth.refresh) return false
  const expiry = credentialsExpiry(connector, credentials)
  return expiry !== null && expiry.getTime() - now.getTime() <= REFRESH_MARGIN_MS
}

export function canRefresh(connector: AnyConnectorDefinition): boolean {
  return connector.auth.type === 'oauth2' && connector.auth.refresh !== undefined
}

/**
 * Serialises every write of a Connection's credentials (refresh, sign-in) for the transaction. An advisory
 * lock, not a row lock: `setHealth` locks the row, and must not wait on a token request (ADR 0020).
 */
export async function lockCredentials(tx: Tx, connectionId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`hanza:connection-credentials:${connectionId}`}, 0))`
}

export interface CurrentCredentials {
  /** Decrypted, not parsed. */
  credentials: unknown
  version: number
  /** False when another run had already refreshed (or a sign-in replaced) them; nothing was sent to the Channel. */
  refreshed: boolean
}

/**
 * Refreshes a Connection's credentials, at most one refresh per Connection at a time (ADR 0020): under the lock it
 * re-reads them; if their version moved since the caller read `seenVersion`, another job refreshed them and they are
 * returned as they are (the loser re-reads). Otherwise, if they are still stale or `force` is set (the Channel just
 * refused them), the connector's `auth.refresh` is called and the result is sealed and written with the version
 * bumped, in the same transaction, so a rotated pair is stored before anything uses it. Connector errors propagate
 * (`AuthExpiredError` when the refresh is refused). Null when the Connection is gone. Worker only.
 */
export async function refreshCredentials(
  ctx: Context,
  input: { organizationId: string; connectionId: string; connector: AnyConnectorDefinition; app: unknown; seenVersion: number; force: boolean },
): Promise<CurrentCredentials | null> {
  const { organizationId, connectionId, connector } = input
  const refresh = connector.auth.type === 'oauth2' ? connector.auth.refresh : undefined
  if (!refresh) throw new Error(`Connector "${connector.id}" cannot refresh credentials`)

  return ctx.db.$transaction(async (tx) => {
    await lockCredentials(tx, connectionId)
    const row = await tx.connection.findFirst({
      where: { id: connectionId, organizationId },
      select: { config: true, credentials: true, credentialsVersion: true },
    })
    if (!row) return null
    const stored: unknown = JSON.parse(ctx.secrets.open(row.credentials, organizationId))
    const version = row.credentialsVersion
    if (version !== input.seenVersion) return { credentials: stored, version, refreshed: false }
    const current = parseCredentials(connector, stored)
    if (!input.force && !needsRefresh(connector, current, new Date())) return { credentials: stored, version, refreshed: false }

    const authContext = buildAuthContext(ctx, connector, { app: input.app, config: parseConfig(connector, row.config), connectionId })
    const fresh = parseCredentials(connector, await refresh(authContext, current))
    const written = await tx.connection.updateMany({
      // Compare-and-swap: a second guard behind the lock.
      where: { id: connectionId, organizationId, credentialsVersion: version },
      data: {
        credentials: ctx.secrets.seal(JSON.stringify(fresh), organizationId),
        credentialsVersion: version + 1,
        credentialsExpireAt: credentialsExpiry(connector, fresh),
      } satisfies Prisma.ConnectionUpdateManyMutationInput,
    })
    if (written.count !== 1) throw new Error('The Connection’s credentials changed during a refresh')
    ctx.log.info('credentials refreshed', { organizationId, connectionId, connectorId: connector.id, version: version + 1 })
    return { credentials: fresh, version: version + 1, refreshed: true }
  }, REFRESH_TX_OPTIONS)
}
