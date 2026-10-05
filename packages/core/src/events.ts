import type { Prisma, Tx } from '@hanza/db'
import type { Context } from './context'

export type EventSubject = { type: 'product' | 'offer' | 'order' | 'connection'; id: string }

export type EventType =
  | 'system.ping'
  | 'product.created'
  | 'product.updated'
  | 'stock.set'
  | 'stock.reserved'
  | 'stock.released'
  | 'stock.consumed'
  | 'offer.linked'
  | 'offer.unlinked'
  | 'order.imported'
  | 'order.channel_fact_recorded'
  | 'order.status_changed'
  | 'order.line_linked'
  | 'order.attention_raised'
  | 'order.attention_resolved'
  | 'connection.created'
  | 'connection.health_changed'

export interface EventRow {
  id: string
  type: string
  subject: EventSubject | null
  payload: Record<string, unknown>
  createdAt: Date
}

/** Appends an Event in the transaction of the change it describes (ADR 0002). Never put Buyer data or credentials in `payload`. */
export async function appendEvent(
  tx: Tx,
  event: { organizationId: string; type: EventType; subject: EventSubject | null; payload: Record<string, unknown> },
): Promise<void> {
  await tx.eventLog.create({
    data: {
      organizationId: event.organizationId,
      type: event.type,
      subjectType: event.subject?.type ?? null,
      subjectId: event.subject?.id ?? null,
      payload: event.payload as Prisma.InputJsonObject,
    },
  })
}

/** Latest first; `subject` null lists every Event of the organization. */
export async function listEvents(
  ctx: Context,
  organizationId: string,
  subject: EventSubject | null,
  take: number,
): Promise<EventRow[]> {
  const rows = await ctx.db.eventLog.findMany({
    where: { organizationId, ...(subject ? { subjectType: subject.type, subjectId: subject.id } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
  })
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    subject: row.subjectType && row.subjectId ? { type: row.subjectType as EventSubject['type'], id: row.subjectId } : null,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
  }))
}
