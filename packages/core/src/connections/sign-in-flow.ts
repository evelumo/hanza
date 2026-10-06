import {
  classifyConnectorError,
  deviceFlowOf,
  deviceSignInPollSchema,
  deviceSignInStartSchema,
  isAllowedVerificationUri,
  PermanentError,
  type AnyConnectorDefinition,
  type DeviceFlow,
  type SignedInAccount,
} from '@hanza/connector-sdk'
import type { SignInStatus } from '@hanza/db'
import { systemActor, type Actor } from '../actor'
import { afterCommit } from '../after-commit'
import type { Context } from '../context'
import { describeFailure } from '../describe-failure'
import { isUniqueViolation } from '../errors'
import { appendEvent } from '../events'
import { RetryLaterError, type JobRunInfo } from '../jobs'
import { coalesceKeys, signInPollRef } from '../jobs/refs'
import { buildAuthContext, connectorApp } from '../sync/auth-context'
import { enqueueSync } from '../sync/requests'
import { retryLaterDelay } from '../sync/run-connector'
import { TX_OPTIONS } from '../transaction'
import { credentialsExpiry, lockCredentials, parseConfig, parseCredentials } from './credentials'
import { insertConnection } from './connections'
import { OPEN_SIGN_IN_STATUSES } from './sign-in'
import { setHealth } from './sync-state'

/** Added to the poll interval when the Channel answers `slow_down` (RFC 8628, 3.5). */
export const SLOW_DOWN_STEP_SECONDS = 5

type SignInRow = {
  id: string
  organizationId: string
  connectorId: string
  connectionId: string | null
  name: string | null
  config: unknown
  status: SignInStatus
  deviceCode: string | null
  intervalSeconds: number | null
  expiresAt: Date
  lastPolledAt: Date | null
  createdByUserId: string | null
}

const rowSelect = {
  id: true,
  organizationId: true,
  connectorId: true,
  connectionId: true,
  name: true,
  config: true,
  status: true,
  deviceCode: true,
  intervalSeconds: true,
  expiresAt: true,
  lastPolledAt: true,
  createdByUserId: true,
} as const

// The device code is bound to its organization and its sign-in: a sealed value copied to another row does not open.
const deviceCodeAad = (row: { organizationId: string; id: string }) => `${row.organizationId}:${row.id}`

async function loadRow(ctx: Context, organizationId: string, signInId: string): Promise<SignInRow | null> {
  return ctx.db.connectionSignIn.findFirst({ where: { id: signInId, organizationId }, select: rowSelect })
}

/** Ends an open sign-in; clears the device code. Does nothing to one that already ended. */
async function finish(ctx: Context, row: SignInRow, status: Exclude<SignInStatus, 'starting' | 'pending'>, reason?: unknown): Promise<void> {
  await ctx.db.connectionSignIn.updateMany({
    where: { id: row.id, organizationId: row.organizationId, status: { in: [...OPEN_SIGN_IN_STATUSES] } },
    data: { status, deviceCode: null, finishedAt: new Date() },
  })
  const fields = { organizationId: row.organizationId, signInId: row.id, connectorId: row.connectorId, status }
  if (reason === undefined) ctx.log.info('sign-in ended', fields)
  else ctx.log.warn('sign-in failed', { ...fields, error: describeFailure(reason) })
}

interface Prepared {
  connector: AnyConnectorDefinition
  flow: DeviceFlow
  authContext: ReturnType<typeof buildAuthContext>
}

/** The connector, its device flow and what its hooks get; ends the sign-in as `failed` when any is unusable. */
async function prepare(ctx: Context, row: SignInRow): Promise<Prepared | null> {
  const connector = ctx.connectors.get(row.connectorId)
  const flow = connector ? deviceFlowOf(connector) : undefined
  if (!connector || !flow) {
    await finish(ctx, row, 'failed', new Error(`Connector "${row.connectorId}" has no device flow in this build`))
    return null
  }
  try {
    let config = row.config
    if (row.connectionId) {
      const connection = await ctx.db.connection.findFirst({
        where: { id: row.connectionId, organizationId: row.organizationId },
        select: { config: true },
      })
      if (!connection) throw new Error('The Connection no longer exists')
      config = connection.config
    }
    const authContext = buildAuthContext(ctx, connector, {
      app: connectorApp(ctx, connector),
      config: parseConfig(connector, config),
      signInId: row.id,
      ...(row.connectionId ? { connectionId: row.connectionId } : {}),
    })
    return { connector, flow, authContext }
  } catch (error) {
    await finish(ctx, row, 'failed', error)
    return null
  }
}

async function schedulePoll(ctx: Context, row: { organizationId: string; id: string }, delayMs: number): Promise<void> {
  await ctx.queue.enqueue(
    signInPollRef,
    { organizationId: row.organizationId, signInId: row.id },
    { coalesceKey: coalesceKeys.signInPoll(row.id), delayMs: Math.max(0, Math.round(delayMs)) },
  )
}

/** Asks the Channel for a device code and stores it (sealed), then schedules the first poll. */
export async function runSignInStart(ctx: Context, organizationId: string, signInId: string, run: JobRunInfo): Promise<void> {
  const row = await loadRow(ctx, organizationId, signInId)
  if (!row || row.status !== 'starting') return
  const prepared = await prepare(ctx, row)
  if (!prepared) return
  const { flow, authContext } = prepared

  let started
  try {
    started = deviceSignInStartSchema.parse(await flow.start(authContext))
  } catch (error) {
    const { kind, retryAfterMs } = classifyConnectorError(error)
    if (kind === 'rate_limited') throw new RetryLaterError(retryLaterDelay(retryAfterMs), describeFailure(error))
    // The queue retries with backoff; the tick expires a sign-in that never gets its code.
    if (kind === 'transient' && run.attempt < run.maxAttempts) throw error
    await finish(ctx, row, 'failed', error)
    return
  }
  const { verificationUri, verificationUriComplete } = started
  if (
    !isAllowedVerificationUri(verificationUri, flow.verificationHosts) ||
    (verificationUriComplete !== null && !isAllowedVerificationUri(verificationUriComplete, flow.verificationHosts))
  ) {
    await finish(ctx, row, 'failed', new PermanentError('The connector returned a verification link outside its verificationHosts'))
    return
  }

  const updated = await ctx.db.connectionSignIn.updateMany({
    where: { id: row.id, organizationId, status: 'starting' },
    data: {
      status: 'pending',
      userCode: started.userCode,
      verificationUri,
      verificationUriComplete,
      deviceCode: ctx.secrets.seal(started.deviceCode, deviceCodeAad(row)),
      intervalSeconds: started.intervalSeconds,
      expiresAt: new Date(Date.now() + started.expiresInSeconds * 1000),
    },
  })
  // Cancelled (or expired) while the Channel answered: nothing to poll.
  if (updated.count === 0) return
  await schedulePoll(ctx, row, started.intervalSeconds * 1000)
}

/**
 * One poll of a pending sign-in. Never polls the Channel before `lastPolledAt + interval` (a duplicate job
 * waits instead), re-schedules itself while the person has not decided, and completes the sign-in on approval.
 */
export async function runSignInPoll(ctx: Context, organizationId: string, signInId: string): Promise<void> {
  const row = await loadRow(ctx, organizationId, signInId)
  if (!row || row.status !== 'pending' || !row.deviceCode) return
  const now = new Date()
  if (row.expiresAt <= now) {
    await finish(ctx, row, 'expired')
    return
  }
  const intervalMs = (row.intervalSeconds ?? SLOW_DOWN_STEP_SECONDS) * 1000
  // Claims this poll: of two jobs that read the same row, only one may call the Channel.
  const claimed = await ctx.db.connectionSignIn.updateMany({
    where: {
      id: row.id,
      organizationId,
      status: 'pending',
      OR: [{ lastPolledAt: null }, { lastPolledAt: { lte: new Date(now.getTime() - intervalMs) } }],
    },
    data: { lastPolledAt: now },
  })
  if (claimed.count === 0) {
    const last = row.lastPolledAt?.getTime() ?? now.getTime()
    await schedulePoll(ctx, row, Math.max(1_000, last + intervalMs - now.getTime()))
    return
  }

  const prepared = await prepare(ctx, row)
  if (!prepared) return
  const { connector, flow, authContext } = prepared

  let result
  try {
    result = deviceSignInPollSchema.parse(await flow.poll(authContext, ctx.secrets.open(row.deviceCode, deviceCodeAad(row))))
  } catch (error) {
    const { kind, retryAfterMs } = classifyConnectorError(error)
    // Bounded by the code's expiry; a hiccup must not end a sign-in the person may be approving right now.
    if (kind === 'transient') return schedulePoll(ctx, row, intervalMs)
    if (kind === 'rate_limited') return schedulePoll(ctx, row, Math.max(intervalMs, retryLaterDelay(retryAfterMs)))
    await finish(ctx, row, 'failed', error)
    return
  }

  switch (result.status) {
    case 'pending':
      return schedulePoll(ctx, row, intervalMs)
    case 'slow_down': {
      const intervalSeconds = (row.intervalSeconds ?? 0) + SLOW_DOWN_STEP_SECONDS
      await ctx.db.connectionSignIn.updateMany({ where: { id: row.id, organizationId, status: 'pending' }, data: { intervalSeconds } })
      return schedulePoll(ctx, row, intervalSeconds * 1000)
    }
    case 'denied':
    case 'expired':
      return finish(ctx, row, result.status)
    case 'approved': {
      let credentials: Record<string, unknown>
      try {
        credentials = parseCredentials(connector, result.credentials) as Record<string, unknown>
      } catch (error) {
        await finish(ctx, row, 'failed', error)
        return
      }
      await completeSignIn(ctx, row, connector, credentials, result.account)
    }
  }
}

type Outcome = { status: 'approved'; connectionId: string; created: boolean } | { status: 'account_mismatch' | 'account_in_use' | 'failed' } | null

/**
 * Stores the credentials of an approved sign-in, in one transaction with the sign-in row locked (a duplicate
 * poll finds it ended and does nothing): a new Connection is created, or an existing one gets its credentials
 * replaced under the credentials lock (ADR 0020) and health back to `unknown`, so the tick schedules it again.
 * A different Channel account than the Connection's, or one another Connection already uses, is refused.
 */
async function completeSignIn(
  ctx: Context,
  row: SignInRow,
  connector: AnyConnectorDefinition,
  credentials: Record<string, unknown>,
  account: SignedInAccount | null,
): Promise<void> {
  const { organizationId } = row
  const actor: Actor = row.createdByUserId ? { type: 'user', userId: row.createdByUserId } : systemActor
  const sealed = ctx.secrets.seal(JSON.stringify(credentials), organizationId)
  const credentialsExpireAt = credentialsExpiry(connector, credentials)
  const end = (status: SignInStatus, connectionId?: string) =>
    ({
      status,
      deviceCode: null,
      finishedAt: new Date(),
      accountLabel: account?.label ?? null,
      ...(connectionId ? { connectionId } : {}),
    }) as const

  let outcome: Outcome
  try {
    outcome = await ctx.db.$transaction(async (tx): Promise<Outcome> => {
      const locked = await tx.$queryRaw<Array<{ status: SignInStatus }>>`
        SELECT "status" FROM "connection_sign_in" WHERE "id" = ${row.id} AND "organizationId" = ${organizationId} FOR UPDATE`
      if (locked[0]?.status !== 'pending') return null
      const refuse = async (status: 'account_mismatch' | 'account_in_use' | 'failed') => {
        await tx.connectionSignIn.updateMany({ where: { id: row.id, organizationId }, data: end(status) })
        return { status }
      }
      const accountTaken = async (exceptConnectionId: string | null) =>
        account !== null &&
        (await tx.connection.count({
          where: { organizationId, connectorId: connector.id, accountId: account.id, ...(exceptConnectionId ? { id: { not: exceptConnectionId } } : {}) },
        })) > 0

      let connectionId: string
      let created = false
      if (row.connectionId) {
        connectionId = row.connectionId
        await lockCredentials(tx, connectionId)
        const connection = await tx.connection.findFirst({
          where: { id: connectionId, organizationId },
          select: { accountId: true, accountLabel: true, credentialsVersion: true },
        })
        if (!connection) return refuse('failed')
        if (account && connection.accountId !== null && connection.accountId !== account.id) return refuse('account_mismatch')
        if (connection.accountId === null && (await accountTaken(connectionId))) return refuse('account_in_use')
        await tx.connection.updateMany({
          where: { id: connectionId, organizationId },
          data: {
            credentials: sealed,
            credentialsVersion: connection.credentialsVersion + 1,
            credentialsExpireAt,
            accountId: connection.accountId ?? account?.id ?? null,
            accountLabel: account?.label ?? connection.accountLabel,
          },
        })
        await setHealth(tx, organizationId, connectionId, 'unknown', null)
      } else {
        if (await accountTaken(null)) return refuse('account_in_use')
        connectionId = await insertConnection(
          ctx,
          tx,
          organizationId,
          {
            connectorId: connector.id,
            name: row.name ?? connector.name,
            config: (row.config ?? {}) as Record<string, unknown>,
            credentials,
            credentialsExpireAt,
            account,
          },
          actor,
        )
        created = true
      }
      await appendEvent(tx, {
        organizationId,
        type: 'connection.signed_in',
        subject: { type: 'connection', id: connectionId },
        payload: { connectorId: connector.id, account: account?.label ?? null, actor },
      })
      await tx.connectionSignIn.updateMany({ where: { id: row.id, organizationId }, data: end('approved', connectionId) })
      return { status: 'approved', connectionId, created }
    }, TX_OPTIONS)
  } catch (error) {
    // Two sign-ins of one Channel account approved at the same moment: the unique index lets one through.
    if (!isUniqueViolation(error)) throw error
    await ctx.db.connectionSignIn.updateMany({ where: { id: row.id, organizationId, status: 'pending' }, data: end('account_in_use') })
    outcome = { status: 'account_in_use' }
  }

  if (outcome === null) return
  ctx.log.info('sign-in ended', { organizationId, signInId: row.id, connectorId: connector.id, status: outcome.status })
  if (outcome.status !== 'approved') return
  const { connectionId } = outcome
  // A lost enqueue: the tick starts every stream of a new Connection within a minute, and of one back from
  // auth_expired once each stream is due again.
  await afterCommit(ctx, { job: 'sync', organizationId, connectionId }, () => enqueueSync(ctx, organizationId, connectionId))
}
