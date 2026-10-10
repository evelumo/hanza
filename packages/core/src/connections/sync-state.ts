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
  const row: { cursor: string | null } | null = await db.syncState.upsert({
    where: { connectionId_stream: { connectionId, stream }, organizationId },
    create: { organizationId, connectionId, stream, ...data },
    update: data,
    select: { cursor: true },
  })
  // With the organizationId filter, a row recorded under another organization is
  // neither updated nor replaced; Prisma then returns null despite the type.
  if (!row) throw new DomainError('not_found')
  return row
}

/**
 * Locks the Connection row so concurrent runs record health transitions (and
 * their Events) exactly once. NO KEY UPDATE: a FOR UPDATE lock would also wait
 * for every in-flight Order/Offer insert on this Connection (their foreign keys
 * take KEY SHARE locks on it).
 */
export async function setHealth(
  tx: Tx,
  organizationId: string,
  connectionId: string,
  to: ConnectionHealth,
  errorKind: SyncErrorKind | null,
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ health: ConnectionHealth }>>`
    SELECT "health" FROM "connection" WHERE "id" = ${connectionId} AND "organizationId" = ${organizationId}
    FOR NO KEY UPDATE`
  const from = rows[0]?.health
  if (from === undefined) throw new DomainError('not_found')
  if (from === to) return
  // Only a sign-in or a successful run clears auth_expired; a later failure must not hide it.
  if (from === 'auth_expired' && to === 'failing') return
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

/**
 * The Channel no longer has the Order feed's position (`CursorExpiredError`): back to cursor null, which starts again
 * with the Orders open now. Recorded as an Event because Orders opened and closed meanwhile are never imported, so a
 * person can see that a gap may exist. Cursor and Event in one transaction: a retry neither loses nor repeats it.
 */
export async function restartOrderFeed(ctx: Context, organizationId: string, connectionId: string): Promise<void> {
  await ctx.db.$transaction(async (tx) => {
    await requireConnection(tx, organizationId, connectionId)
    await writeState(tx, organizationId, connectionId, 'orders_pull', { cursor: null })
    await appendEvent(tx, {
      organizationId,
      type: 'connection.order_feed_restarted',
      subject: { type: 'connection', id: connectionId },
      payload: {},
    })
  }, TX_OPTIONS)
}

/** In the result of an Orders pull that stopped at its page limit: the feed has more to read, and the next run carries on. */
export const ORDER_FEED_MORE = 'more'

/**
 * Whether the Connection's Channel may be told Stock (ADR 0023). Not before its Order feed has been read to its
 * end: until then Hanza does not know the Orders open there and would send Stock without their Reservations, on
 * top of a number the Channel counted right. Read from what the runs record anyway:
 * - the last successful Orders pull reached the end of the feed (its result has no `more`), or
 * - a stock push reached the Channel before. A Channel that was told numbers stays on them, because they also
 *   carry what other Channels sold: a feed that restarted (ADR 0021) or fell behind by more than one run does not
 *   stop its pushes, nor does a Connection older than this rule whose Orders pull never succeeded.
 * So a Channel never told a number gets none while its Orders pull keeps failing: the Connection shows failing (or
 * waiting for sign-in) with the Orders pull's error, and its Offers show their stock as waiting to be sent.
 */
export async function mayPushStock(ctx: Context, organizationId: string, connectionId: string): Promise<boolean> {
  const states = await ctx.db.syncState.findMany({
    where: { organizationId, connectionId, stream: { in: ['orders_pull', 'stock_push'] }, lastSucceededAt: { not: null } },
    select: { stream: true, lastResult: true },
  })
  return states.some((state) => state.stream === 'stock_push' || !((state.lastResult ?? {}) as Record<string, unknown>)[ORDER_FEED_MORE])
}

export async function finishSyncRun(
  ctx: Context,
  organizationId: string,
  connectionId: string,
  stream: SyncStream,
  result: Record<string, number>,
  /**
   * `calledChannel: false` = the run never contacted the Channel (nothing to send), so it proves
   * nothing: only `lastFinishedAt` is updated; result, last success, last error and health stay.
   */
  options: { calledChannel?: boolean } = {},
): Promise<void> {
  if (options.calledChannel === false) {
    await requireConnection(ctx.db, organizationId, connectionId)
    await writeState(ctx.db, organizationId, connectionId, stream, { lastFinishedAt: new Date() })
    return
  }
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
