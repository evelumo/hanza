import type { Tx } from '@hanza/db'
import type { Actor } from '../actor'
import type { Context } from '../context'
import { DomainError } from '../errors'
import { appendEvent } from '../events'
import { CHANNEL_REPORTED_PHASES, type ChannelReportedPhase } from '../orders/phases'
import { TX_OPTIONS } from '../transaction'
import { sharedStatus, snapshotOf, type StatusSnapshot } from './defaults'
import { assertCanManageOrderStatuses } from './permissions'

/** Per reported phase, the status this Channel's Orders get instead of the phase default; null = the default. */
export type StatusMapping = Record<ChannelReportedPhase, string | null>

export async function getStatusMapping(ctx: Context, organizationId: string, connectionId: string): Promise<StatusMapping> {
  const rows = await ctx.db.channelStatusMapping.findMany({ where: { organizationId, connectionId }, select: { phase: true, statusId: true } })
  const mapping: StatusMapping = { new: null, shipped: null, cancelled: null }
  for (const row of rows) {
    if ((CHANNEL_REPORTED_PHASES as readonly string[]).includes(row.phase)) mapping[row.phase as ChannelReportedPhase] = row.statusId
  }
  return mapping
}

/**
 * Sets the Connection's Status mapping for the phases given; null removes it (the phase default applies again).
 * A status must be an active one of the organization and of that phase. Orders already imported keep their status.
 */
export async function setStatusMapping(
  ctx: Context,
  organizationId: string,
  connectionId: string,
  mapping: Partial<StatusMapping>,
  actor: Actor,
): Promise<void> {
  await assertCanManageOrderStatuses(ctx, organizationId, actor)
  await ctx.db.$transaction(async (tx) => {
    const connection = await tx.connection.findFirst({ where: { id: connectionId, organizationId }, select: { id: true } })
    if (!connection) throw new DomainError('not_found')
    for (const phase of CHANNEL_REPORTED_PHASES) {
      const statusId = mapping[phase]
      if (statusId === undefined) continue
      const current = await tx.channelStatusMapping.findFirst({
        where: { organizationId, connectionId, phase },
        select: { id: true, status: { select: { id: true, name: true, phase: true } } },
      })
      if ((current?.status.id ?? null) === statusId) continue

      let to: StatusSnapshot | null = null
      if (statusId === null) {
        await tx.channelStatusMapping.deleteMany({ where: { organizationId, connectionId, phase } })
      } else {
        // FOR SHARE waits for a deactivation or a deletion of the status in progress, so it never maps to one.
        const status = await sharedStatus(tx, organizationId, statusId)
        if (!status || status.phase !== phase) throw new DomainError('not_found')
        if (status.replacedById !== null) throw new DomainError('status_pending_deletion')
        if (!status.active) throw new DomainError('status_inactive')
        to = snapshotOf(status)
        if (current) {
          await tx.channelStatusMapping.updateMany({ where: { id: current.id, organizationId }, data: { statusId } })
        } else {
          await tx.channelStatusMapping.create({ data: { organizationId, connectionId, phase, statusId } })
        }
      }
      await appendEvent(tx, {
        organizationId,
        type: 'connection.status_mapping_changed',
        subject: { type: 'connection', id: connectionId },
        payload: { phase, from: current ? snapshotOf(current.status) : null, to, actor },
      })
    }
  }, TX_OPTIONS)
}

/** Moves every Status mapping from a status being deleted to its replacement, with an Event per Connection. */
export async function moveMappings(tx: Tx, organizationId: string, from: StatusSnapshot, to: StatusSnapshot, actor: Actor): Promise<number> {
  const moved = await tx.channelStatusMapping.findMany({ where: { organizationId, statusId: from.id }, select: { id: true, connectionId: true, phase: true } })
  if (moved.length === 0) return 0
  await tx.channelStatusMapping.updateMany({ where: { organizationId, id: { in: moved.map((row) => row.id) } }, data: { statusId: to.id } })
  for (const row of moved) {
    await appendEvent(tx, {
      organizationId,
      type: 'connection.status_mapping_changed',
      subject: { type: 'connection', id: row.connectionId },
      payload: { phase: row.phase, from, to, cause: 'status_deleted', actor },
    })
  }
  return moved.length
}
