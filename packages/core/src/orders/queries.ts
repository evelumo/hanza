import type { Address, Buyer, Money, OrderStatus } from '@hanza/connector-sdk'
import type { AttentionReason, ChannelFactType, PaymentMethod } from '@hanza/db'
import type { Context } from '../context'
import { listEvents, type EventRow } from '../events'
import { storedBuyerDataSelect, viewBuyerData, type BuyerDataView, type StoredBuyerData } from '../privacy/buyer-data'
import { allowedTransitions, OPEN_STATUSES } from './status-rules'

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
  status: OrderStatus
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
  allowedTransitions: OrderStatus[]
}

const rowSelect = {
  id: true,
  placedAt: true,
  // Includes externalId and connectionId, which the sealed value is bound to.
  ...storedBuyerDataSelect,
  buyerDataErasedAt: true,
  currency: true,
  totalAmount: true,
  status: true,
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
    status: OrderStatus
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
    status: order.status,
    awaitingPayment: order.awaitingPayment,
    attentionReasons: order.attentionReasons,
  }
}

export async function listOrders(
  ctx: Context,
  organizationId: string,
  /** `awaitingPayment` matches open (new, processing) Orders awaiting payment, or every other Order when false. */
  query: { status?: OrderStatus; needsAttention?: boolean; awaitingPayment?: boolean; skip: number; take: number },
): Promise<{ total: number; items: OrderRow[] }> {
  const where = {
    organizationId,
    ...(query.status ? { status: query.status } : {}),
    ...(query.needsAttention === undefined ? {} : { attentionReasons: { isEmpty: !query.needsAttention } }),
    // Only open Orders are still waiting: a cancelled checkout that was never paid is not.
    ...(query.awaitingPayment === undefined
      ? {}
      : query.awaitingPayment
        ? { AND: [{ awaitingPayment: true }, { status: { in: OPEN_STATUSES } }] }
        : { NOT: { awaitingPayment: true, status: { in: OPEN_STATUSES } } }),
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

  const events = await listEvents(ctx, organizationId, { type: 'order', id: order.id }, 50)
  const buyerData = view(ctx, order)
  const present = buyerData.state === 'present' ? buyerData.data : null
  return {
    ...toRow(order, buyerData),
    payment: order.payment,
    buyer: present?.buyer ?? null,
    shippingAddress: present?.shippingAddress ?? null,
    billingAddress: present?.billingAddress ?? null,
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
    allowedTransitions: allowedTransitions(order.status, order.awaitingPayment),
  }
}
