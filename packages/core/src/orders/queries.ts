import type { Address, Buyer, Delivery, Money } from '@hanza/connector-sdk'
import type { AttentionReason, ChannelFactType, OrderStatusColor, PaymentMethod } from '@hanza/db'
import type { Context } from '../context'
import { listEvents, type EventRow } from '../events'
import { storedBuyerDataSelect, viewBuyerData, type BuyerDataView, type StoredBuyerData } from '../privacy/buyer-data'
import { ORDER_PHASES, type OrderPhase } from './phases'
import { allowedStatuses, allowedTransitions, OPEN_PHASES } from './status-rules'

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
  /** Null unless `buyerDataState` is `present`. */
  buyerName: string | null
  /** `unreadable`: the stored value does not open or parse (wrong key, damaged value); the Order id is logged. */
  buyerDataState: BuyerDataView['state']
  buyerDataErasedAt: Date | null
  total: Money
  phase: OrderPhase
  status: OrderStatusLabel
  /** A prepaid Order the Buyer has not paid for yet; it cannot be fulfilled until the Channel reports the payment. */
  awaitingPayment: boolean
  attentionReasons: AttentionReason[]
}

export interface OrderDetail extends OrderRow {
  payment: PaymentMethod
  /** `buyer` and `shippingAddress` are null unless `buyerDataState` is `present`. */
  buyer: Buyer | null
  shippingAddress: Address | null
  billingAddress: Address | null
  /** What the Buyer chose on the Channel; null when the Channel did not say, and unless `buyerDataState` is `present`. */
  delivery: Delivery | null
  /** Kept after erasure. */
  shippingCountryCode: string | null
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
    /** The Warehouse the line's Reservation sits in. */
    reservationWarehouse: { id: string; name: string } | null
  }>
  facts: Array<{ externalId: string; type: ChannelFactType; occurredAt: Date; note: string | null; recordedAt: Date }>
  events: EventRow[]
  /** The other phases a person may move the Order to (`allowedTransitions`); empty in a final phase. */
  allowedTransitions: OrderPhase[]
  /** Where a person may move the Order, phase by phase, then by position. */
  allowedStatuses: OrderStatusLabel[]
}

const rowSelect = {
  id: true,
  placedAt: true,
  // Includes externalId and connectionId, which the sealed value is bound to.
  ...storedBuyerDataSelect,
  buyerDataErasedAt: true,
  currency: true,
  totalAmount: true,
  phase: true,
  status: { select: { id: true, name: true, color: true, phase: true } },
  awaitingPayment: true,
  attentionReasons: true,
  connection: { select: { name: true } },
} as const

function toRow(
  order: StoredBuyerData & {
    id: string
    placedAt: Date
    buyerDataErasedAt: Date | null
    currency: string
    totalAmount: { toFixed(): string }
    phase: OrderPhase
    status: OrderStatusLabel
    awaitingPayment: boolean
    attentionReasons: AttentionReason[]
    connection: { name: string }
  },
  view: BuyerDataView,
): OrderRow {
  return {
    id: order.id,
    externalId: order.externalId,
    connectionId: order.connectionId,
    connectionName: order.connection.name,
    placedAt: order.placedAt,
    buyerName: view.state === 'present' ? view.data.buyer.name : null,
    buyerDataState: view.state,
    buyerDataErasedAt: order.buyerDataErasedAt,
    total: { amount: order.totalAmount.toFixed(), currency: order.currency },
    phase: order.phase,
    status: order.status,
    awaitingPayment: order.awaitingPayment,
    attentionReasons: order.attentionReasons,
  }
}

export async function listOrders(
  ctx: Context,
  organizationId: string,
  /** `awaitingPayment` matches open (new, processing) Orders awaiting payment, or every other Order when false. */
  query: { phase?: OrderPhase; statusId?: string; needsAttention?: boolean; awaitingPayment?: boolean; skip: number; take: number },
): Promise<{ total: number; items: OrderRow[] }> {
  const where = {
    organizationId,
    ...(query.phase ? { phase: query.phase } : {}),
    ...(query.statusId ? { statusId: query.statusId } : {}),
    ...(query.needsAttention === undefined ? {} : { attentionReasons: { isEmpty: !query.needsAttention } }),
    // Only open Orders are still waiting: a cancelled checkout that was never paid is not.
    ...(query.awaitingPayment === undefined
      ? {}
      : query.awaitingPayment
        ? { AND: [{ awaitingPayment: true }, { phase: { in: OPEN_PHASES } }] }
        : { NOT: { awaitingPayment: true, phase: { in: OPEN_PHASES } } }),
  }
  const [total, orders] = await Promise.all([
    ctx.db.order.count({ where }),
    ctx.db.order.findMany({ where, orderBy: [{ placedAt: 'desc' }, { id: 'desc' }], skip: query.skip, take: query.take, select: rowSelect }),
  ])
  return { total, items: orders.map((order) => toRow(order, view(ctx, order))) }
}

function view(ctx: Context, order: StoredBuyerData & { id: string }): BuyerDataView {
  const result = viewBuyerData(ctx.secrets, order)
  if (result.state === 'unreadable') {
    ctx.log.error('buyer data unreadable', { organizationId: order.organizationId, orderId: order.id })
  }
  return result
}

export async function getOrder(ctx: Context, organizationId: string, orderId: string): Promise<OrderDetail | null> {
  const order = await ctx.db.order.findFirst({
    where: { id: orderId, organizationId },
    select: {
      ...rowSelect,
      payment: true,
      shippingCountryCode: true,
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
          reservation: { select: { status: true, warehouse: { select: { id: true, name: true } } } },
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
  const current = { phase: order.phase, statusId: order.status.id, awaitingPayment: order.awaitingPayment }
  const options = allowedStatuses(current, statuses)
    .sort((a, b) => ORDER_PHASES.indexOf(a.phase) - ORDER_PHASES.indexOf(b.phase))
    .map(({ id, name, color, phase }) => ({ id, name, color, phase }))
  const buyerData = view(ctx, order)
  const present = buyerData.state === 'present' ? buyerData.data : null
  return {
    ...toRow(order, buyerData),
    payment: order.payment,
    buyer: present?.buyer ?? null,
    shippingAddress: present?.shippingAddress ?? null,
    billingAddress: present?.billingAddress ?? null,
    delivery: present?.delivery ?? null,
    shippingCountryCode: order.shippingCountryCode,
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
      reservationWarehouse: line.reservation?.warehouse ?? null,
    })),
    facts: order.facts,
    events,
    allowedTransitions: allowedTransitions(order.phase, order.awaitingPayment),
    allowedStatuses: options,
  }
}
