import type { Tx } from '@hanza/db'
import { appendEvent } from '../events'
import { getWarehouseAvailability } from './availability'
import { lockOrder, lockStock } from './locks'
import { chooseWarehouse } from './placement'
import { channelWarehouseIds, defaultWarehouseId } from './warehouse'

export interface ReserveLineInput {
  orderId: string
  orderLineId: string
  /** The Order's Channel: its Warehouses are the candidates (ADR 0017). */
  connectionId: string
  productId: string
  units: number
}

/**
 * Makes the line's Reservation in the Warehouse the placement rule picks among the Channel's
 * Warehouses (`chooseWarehouse`); `consumed` also takes the units off Stock there (linking a line on
 * a shipped Order; nothing while the Product's Stock is unset). The caller must hold the Order lock. The Stock lock is (re)taken here, so
 * Available is read only while every other writer of this Product is blocked; only Warehouses this
 * transaction has share-locked are candidates.
 */
export async function reserveLine(
  tx: Tx,
  organizationId: string,
  line: ReserveLineInput,
  mode: 'open' | 'consumed',
): Promise<{ shortage: boolean; warehouseId: string }> {
  const locked = await lockStock(tx, organizationId, [line.productId])
  const usable = new Set(locked.filter((warehouse) => warehouse.active).map((warehouse) => warehouse.id))
  // The Channel's choice is read without a lock: one committed meanwhile applies to the next Order (ADR 0017).
  const candidates = (await channelWarehouseIds(tx, organizationId, line.connectionId)).filter((id) => usable.has(id))
  const availability = await getWarehouseAvailability(tx, organizationId, line.productId, candidates)
  const { warehouseId, shortage } = chooseWarehouse(
    candidates.map((id) => ({ warehouseId: id, available: availability.get(id)?.available ?? 0 })),
    line.units,
    await defaultWarehouseId(tx, organizationId),
  )

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
  return { shortage, warehouseId }
}

/** Releases the Order's open Reservations; returns the Products touched. */
export async function releaseOrderReservations(tx: Tx, organizationId: string, orderId: string): Promise<string[]> {
  return closeOrderReservations(tx, organizationId, orderId, 'released')
}

/** Consumes the Order's open Reservations, taking their units off Stock in each one's Warehouse; returns the Products touched. */
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
  if (updated === 1) return
  // Unset Stock has no rows (lockStock leaves none): nothing was counted, so nothing is taken, and the count saved
  // later already leaves out what was shipped (#137).
  if ((await tx.stock.count({ where: { organizationId, productId } })) === 0) return
  throw new Error(`Stock row missing for product ${productId} in warehouse ${warehouseId}`)
}
