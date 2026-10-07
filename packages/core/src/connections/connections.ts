import type { ConnectionHealth, Prisma, SyncErrorKind, SyncStream, Tx } from '@hanza/db'
import type { Actor } from '../actor'
import type { Context } from '../context'
import { appendEvent } from '../events'
import type { ChannelStockRules } from '../stock/channel-available'
import { TX_OPTIONS } from '../transaction'

export interface ConnectionRow {
  id: string
  connectorId: string
  name: string
  /** The Channel account it signed in as (e.g. the seller's login), if the connector reports one. */
  accountLabel: string | null
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
  /** Bumped on every write of the credentials; a refresh compares it (ADR 0020). */
  credentialsVersion: number
  health: ConnectionHealth
}

// `credentials` is deliberately absent: panel queries never select it.
const rowSelect = {
  id: true,
  connectorId: true,
  name: true,
  accountLabel: true,
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

export interface NewConnection {
  connectorId: string
  name: string
  config: Record<string, unknown>
  credentials: Record<string, unknown>
  /** When the access token expires, if the connector reports it. */
  credentialsExpireAt?: Date | null
  /** The Channel account, from a sign-in. */
  account?: { id: string; label: string } | null
}

/**
 * Inserts the Connection and its `connection.created` Event in `tx`. The caller has validated config and
 * credentials against the connector. Credentials are sealed with the organization id as AAD, so a value
 * copied to another tenant's row does not open.
 */
export async function insertConnection(ctx: Context, tx: Tx, organizationId: string, input: NewConnection, actor: Actor): Promise<string> {
  const connection = await tx.connection.create({
    data: {
      organizationId,
      connectorId: input.connectorId,
      name: input.name,
      config: input.config as Prisma.InputJsonObject,
      credentials: ctx.secrets.seal(JSON.stringify(input.credentials), organizationId),
      credentialsExpireAt: input.credentialsExpireAt ?? null,
      accountId: input.account?.id ?? null,
      accountLabel: input.account?.label ?? null,
    },
    select: { id: true },
  })
  await appendEvent(tx, {
    organizationId,
    type: 'connection.created',
    subject: { type: 'connection', id: connection.id },
    payload: { connectorId: input.connectorId, actor },
  })
  return connection.id
}

export async function createConnection(ctx: Context, organizationId: string, input: NewConnection, actor: Actor): Promise<{ connectionId: string }> {
  const connectionId = await ctx.db.$transaction((tx) => insertConnection(ctx, tx, organizationId, input, actor), TX_OPTIONS)
  return { connectionId }
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
): Promise<
  | (ConnectionRow & {
      config: Record<string, unknown>
      stockRules: ChannelStockRules
      /** `all`: every active Warehouse counts; otherwise only `warehouseIds` (ADR 0017). */
      warehouses: { all: boolean; warehouseIds: string[] }
    })
  | null
> {
  const row = await ctx.db.connection.findFirst({
    where: { id: connectionId, organizationId },
    select: {
      ...rowSelect,
      config: true,
      safetyBuffer: true,
      channelLimit: true,
      allWarehouses: true,
      warehouses: { where: { organizationId }, orderBy: { warehouseId: 'asc' }, select: { warehouseId: true } },
    },
  })
  if (!row) return null
  const { config, safetyBuffer, channelLimit, allWarehouses, warehouses, ...rest } = row
  return {
    ...toRow(rest),
    config: config as Record<string, unknown>,
    stockRules: { safetyBuffer, channelLimit },
    warehouses: { all: allWarehouses, warehouseIds: allWarehouses ? [] : warehouses.map((choice) => choice.warehouseId) },
  }
}

/** Decrypts the credentials. Worker only: never hand the result to the panel. */
export async function openConnection(ctx: Context, organizationId: string, connectionId: string): Promise<OpenedConnection | null> {
  const row = await ctx.db.connection.findFirst({
    where: { id: connectionId, organizationId },
    select: {
      id: true,
      organizationId: true,
      connectorId: true,
      name: true,
      config: true,
      credentials: true,
      credentialsVersion: true,
      health: true,
    },
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
