import type { Address, Buyer, Money } from '@hanza/connector-sdk'
import { addressSchema } from '@hanza/connector-sdk'
import type { AttentionReason, ChannelFactType, OrderStatusColor, PaymentMethod } from '@hanza/db'
import type { Context } from '../context'
import { listEvents, type EventRow } from '../events'
import { ORDER_PHASES, type OrderPhase } from './phases'
import { allowedStatuses } from './status-rules'

/** An Order status as the panel shows it; a null name is the phase's own name. */
export interface OrderStatusLabel {
  id: string
  name: string | null
  color: OrderStatusColor | null
  phase: OrderPhase
}

export interface OrderRow {
  id: string
  externalId: string
  connectionId: string
  connectionName: string
  placedAt: Date
  buyerName: string
  total: Money
  phase: OrderPhase
  status: OrderStatusLabel
  attentionReasons: AttentionReason[]
}

export interface OrderDetail extends OrderRow {
  payment: PaymentMethod
  buyer: Buyer
  shippingAddress: Address
  billingAddress: Address | null
  lines: Array<{
    id: string
    externalId: string
    offerExternalId: string | null
    sku: string | null
    name: string
    quantity: number
    unitPrice: Money
    productId: string | null
    productSku: string | null
    productName: string | null
    shortage: boolean
    reservationStatus: 'open' | 'released' | 'consumed' | null
  }>
  facts: Array<{ externalId: string; type: ChannelFactType; occurredAt: Date; note: string | null; recordedAt: Date }>
  events: EventRow[]
  /** Where a person may move the Order, phase by phase, then by position. */
  allowedStatuses: OrderStatusLabel[]
}

const rowSelect = {
  id: true,
  externalId: true,
  connectionId: true,
  placedAt: true,
  buyerName: true,
  currency: true,
  totalAmount: true,
  phase: true,
  status: { select: { id: true, name: true, color: true, phase: true } },
  attentionReasons: true,
  connection: { select: { name: true } },
} as const

function toRow(order: {
  id: string
  externalId: string
  connectionId: string
  placedAt: Date
  buyerName: string
  currency: string
  totalAmount: { toFixed(): string }
  phase: OrderPhase
  status: OrderStatusLabel
  attentionReasons: AttentionReason[]
  connection: { name: string }
}): OrderRow {
  return {
    id: order.id,
    externalId: order.externalId,
    connectionId: order.connectionId,
    connectionName: order.connection.name,
    placedAt: order.placedAt,
    buyerName: order.buyerName,
    total: { amount: order.totalAmount.toFixed(), currency: order.currency },
    phase: order.phase,
    status: order.status,
    attentionReasons: order.attentionReasons,
  }
}

export async function listOrders(
  ctx: Context,
  organizationId: string,
  query: { phase?: OrderPhase; statusId?: string; needsAttention?: boolean; skip: number; take: number },
): Promise<{ total: number; items: OrderRow[] }> {
  const where = {
    organizationId,
    ...(query.phase ? { phase: query.phase } : {}),
    ...(query.statusId ? { statusId: query.statusId } : {}),
    ...(query.needsAttention === undefined ? {} : { attentionReasons: { isEmpty: !query.needsAttention } }),
  }
  const [total, orders] = await Promise.all([
    ctx.db.order.count({ where }),
    ctx.db.order.findMany({ where, orderBy: [{ placedAt: 'desc' }, { id: 'desc' }], skip: query.skip, take: query.take, select: rowSelect }),
  ])
  return { total, items: orders.map(toRow) }
}

export async function getOrder(ctx: Context, organizationId: string, orderId: string): Promise<OrderDetail | null> {
  const order = await ctx.db.order.findFirst({
    where: { id: orderId, organizationId },
    select: {
      ...rowSelect,
      payment: true,
      buyerEmail: true,
      buyerPhone: true,
      buyerLogin: true,
      shippingAddress: true,
      billingAddress: true,
      lines: {
        where: { organizationId },
        orderBy: { externalId: 'asc' },
        select: {
          id: true,
          externalId: true,
          offerExternalId: true,
          sku: true,
          name: true,
          quantity: true,
          unitPriceAmount: true,
          productId: true,
          shortage: true,
          product: { select: { sku: true, name: true } },
          reservation: { select: { status: true } },
        },
      },
      facts: {
        where: { organizationId },
        orderBy: [{ occurredAt: 'asc' }, { externalId: 'asc' }],
        select: { externalId: true, type: true, occurredAt: true, note: true, recordedAt: true },
      },
    },
  })
  if (!order) return null

  // An Order always has a status, so its organization's defaults exist already.
  const [events, statuses] = await Promise.all([
    listEvents(ctx, organizationId, { type: 'order', id: order.id }, 50),
    ctx.db.orderStatus.findMany({
      where: { organizationId, active: true },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, color: true, phase: true, active: true },
    }),
  ])
  const options = allowedStatuses({ phase: order.phase, statusId: order.status.id }, statuses)
    .sort((a, b) => ORDER_PHASES.indexOf(a.phase) - ORDER_PHASES.indexOf(b.phase))
    .map(({ id, name, color, phase }) => ({ id, name, color, phase }))
  return {
    ...toRow(order),
    payment: order.payment,
    buyer: { name: order.buyerName, email: order.buyerEmail, phone: order.buyerPhone, login: order.buyerLogin },
    shippingAddress: addressSchema.parse(order.shippingAddress),
    billingAddress: order.billingAddress === null ? null : addressSchema.parse(order.billingAddress),
    lines: order.lines.map((line) => ({
      id: line.id,
      externalId: line.externalId,
      offerExternalId: line.offerExternalId,
      sku: line.sku,
      name: line.name,
      quantity: line.quantity,
      unitPrice: { amount: line.unitPriceAmount.toFixed(), currency: order.currency },
      productId: line.productId,
      productSku: line.product?.sku ?? null,
      productName: line.product?.name ?? null,
      shortage: line.shortage,
      reservationStatus: line.reservation?.status ?? null,
    })),
    facts: order.facts,
    events,
    allowedStatuses: options,
  }
}
