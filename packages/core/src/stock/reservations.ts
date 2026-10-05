import type { Tx } from '@hanza/db'
import { appendEvent } from '../events'
import { getAvailability } from './availability'
import { lockOrder, lockStock } from './locks'
import { defaultWarehouseId } from './warehouse'

export interface ReserveLineInput {
  orderId: string
  orderLineId: string
  productId: string
  units: number
}

/**
 * Makes the line's Reservation in the default Warehouse; `consumed` also takes
 * the units off Stock (linking a line on a shipped Order). The caller must hold
 * the Order lock; the Stock lock is (re)taken here so `availableBefore` is read
 * only while every other writer of this Product is blocked.
 */
export async function reserveLine(
  tx: Tx,
  organizationId: string,
  line: ReserveLineInput,
  mode: 'open' | 'consumed',
): Promise<{ shortage: boolean }> {
  await lockStock(tx, organizationId, [line.productId])
  const warehouseId = await defaultWarehouseId(tx, organizationId)
  const availableBefore = (await getAvailability(tx, organizationId, [line.productId])).get(line.productId)?.available ?? 0

  await tx.reservation.create({
    data: {
      organizationId,
      orderLineId: line.orderLineId,
      productId: line.productId,
      warehouseId,
      units: line.units,
      status: mode,
      closedAt: mode === 'consumed' ? new Date() : null,
    },
  })
  if (mode === 'consumed') await takeFromStock(tx, organizationId, line.productId, warehouseId, line.units)

  await appendEvent(tx, {
    organizationId,
    type: mode === 'open' ? 'stock.reserved' : 'stock.consumed',
    subject: { type: 'product', id: line.productId },
    payload: { orderId: line.orderId, orderLineId: line.orderLineId, warehouseId, units: line.units },
  })
  return { shortage: availableBefore < line.units }
}

/** Releases the Order's open Reservations; returns the Products touched. */
export async function releaseOrderReservations(tx: Tx, organizationId: string, orderId: string): Promise<string[]> {
  return closeOrderReservations(tx, organizationId, orderId, 'released')
}

/** Consumes the Order's open Reservations, taking their units off Stock; returns the Products touched. */
export async function consumeOrderReservations(tx: Tx, organizationId: string, orderId: string): Promise<string[]> {
  return closeOrderReservations(tx, organizationId, orderId, 'consumed')
}

async function closeOrderReservations(
  tx: Tx,
  organizationId: string,
  orderId: string,
  to: 'released' | 'consumed',
): Promise<string[]> {
  // Re-taking the Order lock is free when the caller holds it, and guarantees
  // the Order-before-Stock order: the set of open Reservations read below
  // cannot change while it is held.
  if (!(await lockOrder(tx, organizationId, orderId))) return []
  const open = await tx.reservation.findMany({
    where: { organizationId, status: 'open', orderLine: { orderId } },
    orderBy: [{ productId: 'asc' }, { id: 'asc' }],
  })
  if (open.length === 0) return []
  await lockStock(tx, organizationId, open.map((reservation) => reservation.productId))

  const closedAt = new Date()
  for (const reservation of open) {
    const { count } = await tx.reservation.updateMany({
      where: { id: reservation.id, organizationId, status: 'open' },
      data: { status: to, closedAt },
    })
    if (count === 0) continue
    if (to === 'consumed') {
      await takeFromStock(tx, organizationId, reservation.productId, reservation.warehouseId, reservation.units)
    }
    await appendEvent(tx, {
      organizationId,
      type: to === 'consumed' ? 'stock.consumed' : 'stock.released',
      subject: { type: 'product', id: reservation.productId },
      payload: { orderId, orderLineId: reservation.orderLineId, warehouseId: reservation.warehouseId, units: reservation.units },
    })
  }
  return [...new Set(open.map((reservation) => reservation.productId))]
}

async function takeFromStock(tx: Tx, organizationId: string, productId: string, warehouseId: string, units: number): Promise<void> {
  const updated = await tx.$executeRaw`
    UPDATE "stock" SET "units" = "units" - ${units}, "updatedAt" = now()
    WHERE "organizationId" = ${organizationId} AND "productId" = ${productId} AND "warehouseId" = ${warehouseId}`
  if (updated !== 1) throw new Error(`Stock row missing for product ${productId} in warehouse ${warehouseId}`)
}
