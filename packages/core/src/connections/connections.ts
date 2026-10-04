import type { ConnectionHealth, Prisma, SyncErrorKind, SyncStream } from '@hanza/db'
import type { Actor } from '../actor'
import type { Context } from '../context'
import { appendEvent } from '../events'
import { TX_OPTIONS } from '../transaction'

export interface ConnectionRow {
  id: string
  connectorId: string
  name: string
  health: ConnectionHealth
  healthChangedAt: Date | null
  createdAt: Date
  syncStates: Array<{
    stream: SyncStream
    lastStartedAt: Date | null
    lastFinishedAt: Date | null
    lastSucceededAt: Date | null
    lastResult: Record<string, number> | null
    lastErrorKind: SyncErrorKind | null
    lastError: string | null
  }>
}

export interface OpenedConnection {
  id: string
  organizationId: string
  connectorId: string
  name: string
  config: unknown
  credentials: unknown
  health: ConnectionHealth
}

// `credentials` is deliberately absent: panel queries never select it.
const rowSelect = {
  id: true,
  connectorId: true,
  name: true,
  health: true,
  healthChangedAt: true,
  createdAt: true,
  syncStates: {
    orderBy: { stream: 'asc' },
    select: {
      stream: true,
      lastStartedAt: true,
      lastFinishedAt: true,
      lastSucceededAt: true,
      lastResult: true,
      lastErrorKind: true,
      lastError: true,
    },
  },
} as const satisfies Prisma.ConnectionSelect

type SelectedRow = Prisma.ConnectionGetPayload<{ select: typeof rowSelect }>

function toRow(row: SelectedRow): ConnectionRow {
  return {
    ...row,
    syncStates: row.syncStates.map((state) => ({ ...state, lastResult: (state.lastResult as Record<string, number> | null) ?? null })),
  }
}

/**
 * The caller has validated config and credentials against the connector.
 * Credentials are sealed with the organization id as AAD, so a value copied to another tenant's row does not open.
 */
export async function createConnection(
  ctx: Context,
  organizationId: string,
  input: { connectorId: string; name: string; config: Record<string, unknown>; credentials: Record<string, unknown> },
  actor: Actor,
): Promise<{ connectionId: string }> {
  const credentials = ctx.secrets.seal(JSON.stringify(input.credentials), organizationId)
  return ctx.db.$transaction(async (tx) => {
    const connection = await tx.connection.create({
      data: {
        organizationId,
        connectorId: input.connectorId,
        name: input.name,
        config: input.config as Prisma.InputJsonObject,
        credentials,
      },
      select: { id: true },
    })
    await appendEvent(tx, {
      organizationId,
      type: 'connection.created',
      subject: { type: 'connection', id: connection.id },
      payload: { connectorId: input.connectorId, actor },
    })
    return { connectionId: connection.id }
  }, TX_OPTIONS)
}

export async function listConnections(ctx: Context, organizationId: string): Promise<ConnectionRow[]> {
  const rows = await ctx.db.connection.findMany({
    where: { organizationId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: rowSelect,
  })
  return rows.map(toRow)
}

export async function getConnection(
  ctx: Context,
  organizationId: string,
  connectionId: string,
): Promise<(ConnectionRow & { config: Record<string, unknown> }) | null> {
  const row = await ctx.db.connection.findFirst({
    where: { id: connectionId, organizationId },
    select: { ...rowSelect, config: true },
  })
  if (!row) return null
  const { config, ...rest } = row
  return { ...toRow(rest), config: config as Record<string, unknown> }
}

/** Decrypts the credentials. Worker only: never hand the result to the panel. */
export async function openConnection(ctx: Context, organizationId: string, connectionId: string): Promise<OpenedConnection | null> {
  const row = await ctx.db.connection.findFirst({
    where: { id: connectionId, organizationId },
    select: { id: true, organizationId: true, connectorId: true, name: true, config: true, credentials: true, health: true },
  })
  if (!row) return null
  return { ...row, credentials: JSON.parse(ctx.secrets.open(row.credentials, row.organizationId)) as unknown }
}

/** The only cross-tenant query; used by `sync.tick` to decide what is due. */
export async function listConnectionsForTick(ctx: Context): Promise<
  Array<{ id: string; organizationId: string; connectorId: string; health: ConnectionHealth; lastStartedAt: Partial<Record<SyncStream, Date>> }>
> {
  const rows = await ctx.db.connection.findMany({
    orderBy: { id: 'asc' },
    select: {
      id: true,
      organizationId: true,
      connectorId: true,
      health: true,
      syncStates: { select: { stream: true, lastStartedAt: true } },
    },
  })
  return rows.map(({ syncStates, ...row }) => {
    const lastStartedAt: Partial<Record<SyncStream, Date>> = {}
    for (const state of syncStates) if (state.lastStartedAt) lastStartedAt[state.stream] = state.lastStartedAt
    return { ...row, lastStartedAt }
  })
}
