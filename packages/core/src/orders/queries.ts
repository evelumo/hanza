import type { Address, Buyer, Money, OrderStatus } from '@hanza/connector-sdk'
import type { AttentionReason, ChannelFactType, PaymentMethod } from '@hanza/db'
import type { Context } from '../context'
import { listEvents, type EventRow } from '../events'
import { readBuyerData, storedBuyerDataSelect, type BuyerData, type StoredBuyerData } from '../privacy/buyer-data'
import { allowedTransitions } from './status-rules'

export interface OrderRow {
  id: string
  externalId: string
  connectionId: string
  connectionName: string
  placedAt: Date
  /** Null once the Buyer data was erased. */
  buyerName: string | null
  buyerDataErasedAt: Date | null
  total: Money
  status: OrderStatus
  attentionReasons: AttentionReason[]
}

export interface OrderDetail extends OrderRow {
  payment: PaymentMethod
  /** `buyer` and `shippingAddress` are null once the Buyer data was erased. */
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
    attentionReasons: AttentionReason[]
    connection: { name: string }
  },
  buyerData: BuyerData | null,
): OrderRow {
  return {
    id: order.id,
    externalId: order.externalId,
    connectionId: order.connectionId,
    connectionName: order.connection.name,
    placedAt: order.placedAt,
    buyerName: buyerData?.buyer.name ?? null,
    buyerDataErasedAt: order.buyerDataErasedAt,
    total: { amount: order.totalAmount.toFixed(), currency: order.currency },
    status: order.status,
    attentionReasons: order.attentionReasons,
  }
}

export async function listOrders(
  ctx: Context,
  organizationId: string,
  query: { status?: OrderStatus; needsAttention?: boolean; skip: number; take: number },
): Promise<{ total: number; items: OrderRow[] }> {
  const where = {
    organizationId,
    ...(query.status ? { status: query.status } : {}),
    ...(query.needsAttention === undefined ? {} : { attentionReasons: { isEmpty: !query.needsAttention } }),
  }
  const [total, orders] = await Promise.all([
    ctx.db.order.count({ where }),
    ctx.db.order.findMany({ where, orderBy: [{ placedAt: 'desc' }, { id: 'desc' }], skip: query.skip, take: query.take, select: rowSelect }),
  ])
  return { total, items: orders.map((order) => toRow(order, readBuyerData(ctx.secrets, order))) }
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

  const events = await listEvents(ctx, organizationId, { type: 'order', id: order.id }, 50)
  const buyerData = readBuyerData(ctx.secrets, order)
  return {
    ...toRow(order, buyerData),
    payment: order.payment,
    buyer: buyerData?.buyer ?? null,
    shippingAddress: buyerData?.shippingAddress ?? null,
    billingAddress: buyerData?.billingAddress ?? null,
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
    })),
    facts: order.facts,
    events,
    allowedTransitions: allowedTransitions(order.status),
  }
}
