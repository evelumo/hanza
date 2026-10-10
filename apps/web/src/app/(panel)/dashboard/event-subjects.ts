import type { Context, EventRow } from '@hanza/core'
import { eventRefsToResolve, type EventIdentifiers } from '@/lib/events'

/**
 * How people know the records the dashboard's Events are about: the Order number, the SKU, the Offer's external
 * id, the name. One organization-scoped query for each kind the Events mention, and none for a kind they do not.
 * A record that is gone (a deleted Warehouse) is simply not in the answer.
 */
export async function loadEventIdentifiers(ctx: Context, organizationId: string, events: EventRow[]): Promise<EventIdentifiers> {
  const ids = eventRefsToResolve(events)
  const where = (kind: keyof typeof ids) => ({ organizationId, id: { in: ids[kind] } })
  const byId = <T extends { id: string }>(rows: T[], identifier: (row: T) => string) => new Map(rows.map((row) => [row.id, identifier(row)]))
  const none = Promise.resolve([])
  const [orders, products, offers, connections, warehouses, families] = await Promise.all([
    ids.order.length ? ctx.db.order.findMany({ where: where('order'), select: { id: true, externalId: true } }) : none,
    ids.product.length ? ctx.db.product.findMany({ where: where('product'), select: { id: true, sku: true } }) : none,
    ids.offer.length ? ctx.db.offer.findMany({ where: where('offer'), select: { id: true, externalId: true } }) : none,
    ids.connection.length ? ctx.db.connection.findMany({ where: where('connection'), select: { id: true, name: true } }) : none,
    ids.warehouse.length ? ctx.db.warehouse.findMany({ where: where('warehouse'), select: { id: true, name: true } }) : none,
    ids.product_family.length ? ctx.db.productFamily.findMany({ where: where('product_family'), select: { id: true, name: true } }) : none,
  ])
  return {
    order: byId(orders, (row) => row.externalId),
    product: byId(products, (row) => row.sku),
    offer: byId(offers, (row) => row.externalId),
    connection: byId(connections, (row) => row.name),
    warehouse: byId(warehouses, (row) => row.name),
    product_family: byId(families, (row) => row.name),
  }
}
