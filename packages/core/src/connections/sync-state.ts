import type { ConnectionHealth, Prisma, SyncErrorKind, SyncStream, Tx } from '@hanza/db'
import type { Context } from '../context'
import { DomainError } from '../errors'
import { appendEvent } from '../events'
import { TX_OPTIONS } from '../transaction'

const MAX_ERROR_LENGTH = 1000

async function requireConnection(db: Tx, organizationId: string, connectionId: string): Promise<void> {
  const connection = await db.connection.findFirst({ where: { id: connectionId, organizationId }, select: { id: true } })
  if (!connection) throw new DomainError('not_found')
}

async function writeState(
  db: Tx,
  organizationId: string,
  connectionId: string,
  stream: SyncStream,
  data: {
    cursor?: string | null
    lastStartedAt?: Date
    lastFinishedAt?: Date
    lastSucceededAt?: Date
    lastResult?: Prisma.InputJsonObject
    lastErrorKind?: SyncErrorKind | null
    lastError?: string | null
  },
): Promise<{ cursor: string | null }> {
  return db.syncState.upsert({
    where: { connectionId_stream: { connectionId, stream } },
    create: { organizationId, connectionId, stream, ...data },
    update: data,
    select: { cursor: true },
  })
}

/** Locks the Connection row so concurrent runs record health transitions (and their Events) exactly once. */
async function setHealth(
  tx: Tx,
  organizationId: string,
  connectionId: string,
  to: ConnectionHealth,
  errorKind: SyncErrorKind | null,
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ health: ConnectionHealth }>>`
    SELECT "health" FROM "connection" WHERE "id" = ${connectionId} AND "organizationId" = ${organizationId} FOR UPDATE`
  const from = rows[0]?.health
  if (from === undefined) throw new DomainError('not_found')
  if (from === to) return
  await tx.connection.updateMany({ where: { id: connectionId, organizationId }, data: { health: to, healthChangedAt: new Date() } })
  await appendEvent(tx, {
    organizationId,
    type: 'connection.health_changed',
    subject: { type: 'connection', id: connectionId },
    payload: { from, to, errorKind },
  })
}

/** Marks the start of a run; returns the persisted cursor (only `orders_pull` keeps one). */
export async function startSyncRun(
  ctx: Context,
  organizationId: string,
  connectionId: string,
  stream: SyncStream,
): Promise<{ cursor: string | null }> {
  await requireConnection(ctx.db, organizationId, connectionId)
  return writeState(ctx.db, organizationId, connectionId, stream, { lastStartedAt: new Date() })
}

export async function saveSyncCursor(
  ctx: Context,
  organizationId: string,
  connectionId: string,
  stream: SyncStream,
  cursor: string | null,
): Promise<void> {
  await requireConnection(ctx.db, organizationId, connectionId)
  await writeState(ctx.db, organizationId, connectionId, stream, { cursor })
}

export async function finishSyncRun(
  ctx: Context,
  organizationId: string,
  connectionId: string,
  stream: SyncStream,
  result: Record<string, number>,
): Promise<void> {
  await ctx.db.$transaction(async (tx) => {
    await requireConnection(tx, organizationId, connectionId)
    const now = new Date()
    await writeState(tx, organizationId, connectionId, stream, {
      lastFinishedAt: now,
      lastSucceededAt: now,
      lastResult: result,
      lastErrorKind: null,
      lastError: null,
    })
    await setHealth(tx, organizationId, connectionId, 'ok', null)
  }, TX_OPTIONS)
}

export async function failSyncRun(
  ctx: Context,
  organizationId: string,
  connectionId: string,
  stream: SyncStream,
  failure: { kind: SyncErrorKind; message: string; health: 'failing' | 'auth_expired' | null },
): Promise<void> {
  await ctx.db.$transaction(async (tx) => {
    await requireConnection(tx, organizationId, connectionId)
    await writeState(tx, organizationId, connectionId, stream, {
      lastFinishedAt: new Date(),
      lastErrorKind: failure.kind,
      lastError: failure.message.slice(0, MAX_ERROR_LENGTH),
    })
    if (failure.health) await setHealth(tx, organizationId, connectionId, failure.health, failure.kind)
  }, TX_OPTIONS)
}
