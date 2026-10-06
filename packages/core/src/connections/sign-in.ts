import { deviceFlowOf } from '@hanza/connector-sdk'
import type { Prisma, SignInStatus } from '@hanza/db'
import type { z } from 'zod'
import type { Actor } from '../actor'
import { afterCommit } from '../after-commit'
import type { Context } from '../context'
import { DomainError } from '../errors'
import { coalesceKeys, signInStartRef } from '../jobs/refs'
import { TX_OPTIONS } from '../transaction'

/** A sign-in still `starting` after this (its start job was lost or keeps failing) is expired by the tick. */
export const SIGN_IN_START_TIMEOUT_MS = 10 * 60_000
/** Ended sign-ins are deleted by the tick this long after they ended. */
export const SIGN_IN_KEEP_MS = 24 * 3_600_000

export const OPEN_SIGN_IN_STATUSES = ['starting', 'pending'] as const satisfies readonly SignInStatus[]

export interface SignInView {
  id: string
  connectorId: string
  /** The Connection signing in again, or (once approved) the one created. */
  connectionId: string | null
  /** Name of the new Connection; null when signing in again. */
  name: string | null
  /** True when this sign-in replaces the credentials of an existing Connection. */
  reconnect: boolean
  status: SignInStatus
  userCode: string | null
  verificationUri: string | null
  verificationUriComplete: string | null
  expiresAt: Date
  /** The Channel account that approved, when known. */
  accountLabel: string | null
  createdAt: Date
}

// `deviceCode` is deliberately absent: the panel never reads it.
const viewSelect = {
  id: true,
  connectorId: true,
  connectionId: true,
  name: true,
  status: true,
  userCode: true,
  verificationUri: true,
  verificationUriComplete: true,
  expiresAt: true,
  accountLabel: true,
  createdAt: true,
} as const satisfies Prisma.ConnectionSignInSelect

type Issue = { path: string; message: string }

function issues(prefix: string, error: z.ZodError): Issue[] {
  return error.issues.map((issue) => ({ path: [prefix, ...issue.path.map(String)].join('.'), message: issue.message }))
}

export type StartSignInInput = { connectorId: string; name: string; config: unknown } | { connectionId: string }

/**
 * Starts an interactive sign-in (the connector's device flow) for a new Connection, or for an existing one
 * that must sign in again. The worker asks the Channel for a code (it needs the installation's client
 * secret); the panel shows it from `getSignIn`. Signing in again cancels that Connection's earlier open sign-ins.
 */
export async function startSignIn(ctx: Context, organizationId: string, input: StartSignInInput, actor: Actor): Promise<{ signInId: string }> {
  const createdByUserId = actor.type === 'user' ? actor.userId : null
  const expiresAt = new Date(Date.now() + SIGN_IN_START_TIMEOUT_MS)
  let signInId: string

  if ('connectionId' in input) {
    const connection = await ctx.db.connection.findFirst({
      where: { id: input.connectionId, organizationId },
      select: { id: true, connectorId: true },
    })
    if (!connection) throw new DomainError('not_found')
    const connector = ctx.connectors.requireConfigured(connection.connectorId)
    if (!deviceFlowOf(connector)) throw new DomainError('no_sign_in')
    signInId = await ctx.db.$transaction(async (tx) => {
      await tx.connectionSignIn.updateMany({
        where: { organizationId, connectionId: connection.id, status: { in: [...OPEN_SIGN_IN_STATUSES] } },
        data: { status: 'cancelled', deviceCode: null, finishedAt: new Date() },
      })
      const row = await tx.connectionSignIn.create({
        data: { organizationId, connectorId: connector.id, connectionId: connection.id, expiresAt, createdByUserId },
        select: { id: true },
      })
      return row.id
    }, TX_OPTIONS)
  } else {
    const connector = ctx.connectors.requireConfigured(input.connectorId)
    if (!deviceFlowOf(connector)) throw new DomainError('no_sign_in')
    const config = connector.configSchema.safeParse(input.config)
    if (!config.success) {
      throw new DomainError('invalid_config', 'The settings do not match the connector', { issues: issues('config', config.error) })
    }
    const row = await ctx.db.connectionSignIn.create({
      data: {
        organizationId,
        connectorId: connector.id,
        name: input.name,
        // Parsed values are stored, so defaults are applied once and unknown keys dropped, as in addConnection.
        config: config.data as Prisma.InputJsonObject,
        expiresAt,
        createdByUserId,
      },
      select: { id: true },
    })
    signInId = row.id
  }

  // A lost enqueue leaves the sign-in `starting`; the tick expires it after SIGN_IN_START_TIMEOUT_MS and the panel offers "Try again".
  await afterCommit(ctx, { job: signInStartRef.name, organizationId, signInId }, () =>
    ctx.queue.enqueue(signInStartRef, { organizationId, signInId }, { coalesceKey: coalesceKeys.signInStart(signInId) }),
  )
  return { signInId }
}

/** For the panel; never includes the device code. */
export async function getSignIn(ctx: Context, organizationId: string, signInId: string): Promise<SignInView | null> {
  const row = await ctx.db.connectionSignIn.findFirst({ where: { id: signInId, organizationId }, select: viewSelect })
  if (!row) return null
  // A pending row past its expiry is shown as expired even before the tick marks it.
  const status = OPEN_SIGN_IN_STATUSES.includes(row.status as never) && row.expiresAt <= new Date() ? 'expired' : row.status
  return { ...row, status, reconnect: row.name === null }
}

/** Ends a sign-in that has not finished; a finished one is left as it is. */
export async function cancelSignIn(ctx: Context, organizationId: string, signInId: string): Promise<void> {
  const row = await ctx.db.connectionSignIn.findFirst({ where: { id: signInId, organizationId }, select: { id: true } })
  if (!row) throw new DomainError('not_found')
  await ctx.db.connectionSignIn.updateMany({
    where: { id: signInId, organizationId, status: { in: [...OPEN_SIGN_IN_STATUSES] } },
    data: { status: 'cancelled', deviceCode: null, finishedAt: new Date() },
  })
}

/**
 * Run by `sync.tick` across organizations, by time only: sign-ins still open past their expiry become `expired`
 * (their device code is cleared), and ended ones are deleted a day after they ended.
 */
export async function sweepSignIns(ctx: Context, now: Date): Promise<{ expired: number; deleted: number }> {
  const expired = await ctx.db.connectionSignIn.updateMany({
    where: { status: { in: [...OPEN_SIGN_IN_STATUSES] }, expiresAt: { lte: now } },
    data: { status: 'expired', deviceCode: null, finishedAt: now },
  })
  const deleted = await ctx.db.connectionSignIn.deleteMany({
    where: { status: { notIn: [...OPEN_SIGN_IN_STATUSES] }, finishedAt: { lte: new Date(now.getTime() - SIGN_IN_KEEP_MS) } },
  })
  return { expired: expired.count, deleted: deleted.count }
}
