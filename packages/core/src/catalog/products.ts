import type { Money } from '@hanza/connector-sdk'
import type { Actor } from '../actor'
import type { Context } from '../context'
import { DomainError, isUniqueViolation } from '../errors'
import { appendEvent } from '../events'
import { rematchAfterCommit } from '../orders/rematch'
import { describeOfferPrice, offerPriceColumns, type OfferPriceView } from '../prices/offer-price'
import { moneyFromColumns } from '../prices/price'
import { requestPricePushAfterCommit } from '../prices/push'
import { getAvailability, getWarehouseAvailability, type Availability } from '../stock/availability'
import { requestStockPushAfterCommit } from '../stock/push'
import { DEFAULT_WAREHOUSE_CODE, ensureDefaultWarehouse } from '../stock/warehouse'
import { TX_OPTIONS } from '../transaction'
import { autoLinkOffersBySku } from './auto-link'
import { normalizeSku } from './sku'

/** The family a Product is in and its value for each of the family's attributes, in the family's order. */
export interface ProductFamilyRef {
  id: string
  name: string
  attributes: Array<{ name: string; value: string }>
}

/** `none`: Products that are in no family; `{ id }`: the Products of one family. */
export type ProductFamilyFilter = 'none' | { id: string }

export interface ProductRow {
  id: string
  sku: string
  name: string
  stock: number
  reserved: number
  available: number
  linkedOffers: number
  family: ProductFamilyRef | null
}

export interface ProductDetail extends ProductRow {
  basePrice: Money | null
  offers: Array<
    {
      id: string
      connectionId: string
      connectionName: string
      externalId: string
      name: string
      linkedBy: 'sku' | 'manual'
      lastPushedAvailable: number | null
      lastPushedAt: Date | null
    } & OfferPriceView
  >
  /** Active Warehouses in placement order, each with this Product's Stock, Reserved and Available there. */
  warehouses: Array<{ id: string; name: string; isDefault: boolean } & Availability>
  openReservations: Array<{ orderId: string; orderExternalId: string; units: number; createdAt: Date; warehouseName: string }>
}

export type CreateProductsSkipReason = 'not_found' | 'no_sku' | 'sku_taken' | 'already_linked'

const familySelect = { select: { id: true, name: true, attributes: true } } as const

function familyRef(
  family: { id: string; name: string; attributes: string[] } | null,
  values: unknown,
): ProductFamilyRef | null {
  if (!family) return null
  const record = values && typeof values === 'object' && !Array.isArray(values) ? (values as Record<string, unknown>) : {}
  return {
    id: family.id,
    name: family.name,
    attributes: family.attributes.map((name) => ({ name, value: typeof record[name] === 'string' ? record[name] : '' })),
  }
}

export async function createProduct(
  ctx: Context,
  organizationId: string,
  input: { sku: string; name: string; stock: number },
  actor: Actor,
): Promise<{ productId: string }> {
  const sku = normalizeSku(input.sku)
  if (!sku) throw new RangeError('SKU must not be empty')
  if (!Number.isInteger(input.stock) || input.stock < 0) throw new RangeError('Stock must be an integer >= 0')
  const warehouseId = await ensureDefaultWarehouse(ctx.db, organizationId)

  const { productId, connectionIds } = await ctx.db.$transaction(async (tx) => {
    let product: { id: string }
    try {
      product = await tx.product.create({ data: { organizationId, sku, name: input.name }, select: { id: true } })
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainError('sku_taken')
      throw error
    }
    await tx.stock.create({ data: { organizationId, productId: product.id, warehouseId, units: input.stock } })
    await appendEvent(tx, {
      organizationId,
      type: 'product.created',
      subject: { type: 'product', id: product.id },
      payload: { sku, origin: 'manual', actor },
    })
    const linked = await autoLinkOffersBySku(tx, organizationId, { id: product.id, sku }, actor)
    return { productId: product.id, connectionIds: linked.connectionIds }
  }, TX_OPTIONS)

  await requestStockPushAfterCommit(ctx, organizationId, connectionIds)
  await requestPricePushAfterCommit(ctx, organizationId, connectionIds)
  await rematchAfterCommit(ctx, organizationId, { productId })
  return { productId }
}

/** SKU is immutable in stage 1. */
export async function updateProduct(
  ctx: Context,
  organizationId: string,
  productId: string,
  input: { name: string },
  actor: Actor,
): Promise<void> {
  await ctx.db.$transaction(async (tx) => {
    const product = await tx.product.findFirst({ where: { id: productId, organizationId }, select: { name: true } })
    if (!product) throw new DomainError('not_found')
    if (product.name === input.name) return
    await tx.product.updateMany({ where: { id: productId, organizationId }, data: { name: input.name } })
    await appendEvent(tx, {
      organizationId,
      type: 'product.updated',
      subject: { type: 'product', id: productId },
      payload: { name: { from: product.name, to: input.name }, actor },
    })
  }, TX_OPTIONS)
}

export async function findProductBySku(ctx: Context, organizationId: string, sku: string): Promise<{ id: string } | null> {
  const normalized = normalizeSku(sku)
  if (!normalized) return null
  return ctx.db.product.findFirst({ where: { organizationId, sku: normalized }, select: { id: true } })
}

export async function listProducts(
  ctx: Context,
  organizationId: string,
  query: { search?: string; family?: ProductFamilyFilter; skip: number; take: number },
): Promise<{ total: number; items: ProductRow[] }> {
  const search = query.search?.trim()
  const where = {
    organizationId,
    ...(query.family === 'none' ? { familyId: null } : query.family ? { familyId: query.family.id } : {}),
    ...(search
      ? {
          OR: [
            { sku: { contains: search, mode: 'insensitive' as const } },
            { name: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  }
  const [total, products] = await Promise.all([
    ctx.db.product.count({ where }),
    ctx.db.product.findMany({
      where,
      orderBy: { sku: 'asc' },
      skip: query.skip,
      take: query.take,
      select: { id: true, sku: true, name: true, attributeValues: true, family: familySelect, _count: { select: { offers: true } } },
    }),
  ])
  const availability = await getAvailability(ctx.db, organizationId, products.map((product) => product.id))
  return {
    total,
    items: products.map((product) => ({
      id: product.id,
      sku: product.sku,
      name: product.name,
      ...(availability.get(product.id) ?? { stock: 0, reserved: 0, available: 0 }),
      linkedOffers: product._count.offers,
      family: familyRef(product.family, product.attributeValues),
    })),
  }
}

export async function getProduct(ctx: Context, organizationId: string, productId: string): Promise<ProductDetail | null> {
  const product = await ctx.db.product.findFirst({
    where: { id: productId, organizationId },
    select: {
      id: true,
      sku: true,
      name: true,
      attributeValues: true,
      family: familySelect,
      basePriceAmount: true,
      basePriceCurrency: true,
      offers: {
        where: { organizationId },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          connectionId: true,
          externalId: true,
          name: true,
          linkedBy: true,
          lastPushedAvailable: true,
          lastPushedAt: true,
          ...offerPriceColumns,
          connection: { select: { name: true, connectorId: true } },
        },
      },
    },
  })
  if (!product) return null
  const basePrice = moneyFromColumns(product.basePriceAmount, product.basePriceCurrency)

  await ensureDefaultWarehouse(ctx.db, organizationId)
  const warehouses = await ctx.db.warehouse.findMany({
    where: { organizationId, active: true },
    orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true, code: true },
  })
  const [availability, byWarehouse, reservations] = await Promise.all([
    getAvailability(ctx.db, organizationId, [product.id]),
    getWarehouseAvailability(ctx.db, organizationId, product.id, warehouses.map((warehouse) => warehouse.id)),
    ctx.db.reservation.findMany({
      where: { organizationId, productId: product.id, status: 'open' },
      orderBy: { createdAt: 'asc' },
      select: {
        units: true,
        createdAt: true,
        warehouse: { select: { name: true } },
        orderLine: { select: { order: { select: { id: true, externalId: true } } } },
      },
    }),
  ])
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    ...(availability.get(product.id) ?? { stock: 0, reserved: 0, available: 0 }),
    linkedOffers: product.offers.length,
    family: familyRef(product.family, product.attributeValues),
    basePrice,
    offers: product.offers.map((offer) => ({
      id: offer.id,
      connectionId: offer.connectionId,
      connectionName: offer.connection.name,
      externalId: offer.externalId,
      name: offer.name,
      // A linked Offer always records how it was linked.
      linkedBy: offer.linkedBy ?? 'manual',
      lastPushedAvailable: offer.lastPushedAvailable,
      lastPushedAt: offer.lastPushedAt,
      ...describeOfferPrice(ctx, { ...offer, connectorId: offer.connection.connectorId }, { basePrice }),
    })),
    warehouses: warehouses.map((warehouse) => ({
      id: warehouse.id,
      name: warehouse.name,
      isDefault: warehouse.code === DEFAULT_WAREHOUSE_CODE,
      ...(byWarehouse.get(warehouse.id) ?? { stock: 0, reserved: 0, available: 0 }),
    })),
    openReservations: reservations.map((reservation) => ({
      orderId: reservation.orderLine.order.id,
      orderExternalId: reservation.orderLine.order.externalId,
      units: reservation.units,
      createdAt: reservation.createdAt,
      warehouseName: reservation.warehouse.name,
    })),
  }
}

/**
 * One Product per Offer (its SKU and name, Stock 0, no base price), the Offer linked by SKU. One transaction for all.
 * The Channel price is never copied into the base price: auto-linking would push one Channel's price to every other
 * Channel selling the SKU without anyone having set it (ADR 0011).
 */
export async function createProductsFromOffers(
  ctx: Context,
  organizationId: string,
  offerIds: string[],
  actor: Actor,
): Promise<{ created: string[]; skipped: Array<{ offerId: string; reason: CreateProductsSkipReason }> }> {
  const warehouseId = await ensureDefaultWarehouse(ctx.db, organizationId)
  const requested = [...new Set(offerIds)]

  const result = await ctx.db.$transaction(async (tx) => {
    // Every Offer this transaction may link, locked in id order (see markOffersForStockPush)
    // before they are read, so an Offer linked concurrently is seen as already linked.
    await tx.$queryRaw`
      SELECT "id" FROM "offer"
      WHERE "organizationId" = ${organizationId}
        AND ("id" = ANY(${requested}::text[])
          OR ("linkedBy" IS NULL AND "sku" IN (
            SELECT "sku" FROM "offer" WHERE "organizationId" = ${organizationId} AND "id" = ANY(${requested}::text[]))))
      ORDER BY "id"
      FOR UPDATE`
    const offers = await tx.offer.findMany({
      where: { organizationId, id: { in: requested } },
      select: { id: true, sku: true, name: true, productId: true },
    })
    const skus = [...new Set(offers.map((offer) => offer.sku).filter((sku): sku is string => sku !== null))]
    const existing = await tx.product.findMany({ where: { organizationId, sku: { in: skus } }, select: { sku: true } })
    const taken = new Set(existing.map((product) => product.sku))

    const byId = new Map(offers.map((offer) => [offer.id, offer]))
    const skipped: Array<{ offerId: string; reason: CreateProductsSkipReason }> = []
    const toCreate: Array<{ offerId: string; sku: string; name: string }> = []
    for (const offerId of requested) {
      const offer = byId.get(offerId)
      const sku = offer?.sku ?? null
      if (!offer) skipped.push({ offerId, reason: 'not_found' })
      else if (offer.productId !== null) skipped.push({ offerId, reason: 'already_linked' })
      else if (sku === null) skipped.push({ offerId, reason: 'no_sku' })
      else if (taken.has(sku)) skipped.push({ offerId, reason: 'sku_taken' })
      else {
        taken.add(sku)
        toCreate.push({ offerId, sku, name: offer.name })
      }
    }

    // skipDuplicates covers a Product created concurrently since the check above.
    const products = await tx.product.createManyAndReturn({
      data: toCreate.map((item) => ({ organizationId, sku: item.sku, name: item.name })),
      skipDuplicates: true,
      select: { id: true, sku: true },
    })
    const productBySku = new Map(products.map((product) => [product.sku, product.id]))
    await tx.stock.createMany({ data: products.map((product) => ({ organizationId, productId: product.id, warehouseId, units: 0 })) })

    const created: string[] = []
    const connectionIds = new Set<string>()
    for (const item of toCreate) {
      const productId = productBySku.get(item.sku)
      if (!productId) {
        skipped.push({ offerId: item.offerId, reason: 'sku_taken' })
        continue
      }
      created.push(productId)
      await appendEvent(tx, {
        organizationId,
        type: 'product.created',
        subject: { type: 'product', id: productId },
        payload: { sku: item.sku, origin: 'offer', actor },
      })
      const linked = await tx.offer.updateManyAndReturn({
        where: { id: item.offerId, organizationId, productId: null },
        data: { productId, linkedBy: 'sku', stockPushSeq: { increment: 1 }, pricePushSeq: { increment: 1 } },
        select: { connectionId: true },
      })
      for (const offer of linked) {
        connectionIds.add(offer.connectionId)
        await appendEvent(tx, {
          organizationId,
          type: 'offer.linked',
          subject: { type: 'offer', id: item.offerId },
          payload: { productId, linkedBy: 'sku', actor },
        })
      }
      const others = await autoLinkOffersBySku(tx, organizationId, { id: productId, sku: item.sku }, actor)
      for (const connectionId of others.connectionIds) connectionIds.add(connectionId)
    }
    return { created, skipped, connectionIds: [...connectionIds] }
  }, TX_OPTIONS)

  await requestStockPushAfterCommit(ctx, organizationId, result.connectionIds)
  await requestPricePushAfterCommit(ctx, organizationId, result.connectionIds)
  if (result.created.length > 0) await rematchAfterCommit(ctx, organizationId, { productIds: result.created.join(',') })
  return { created: result.created, skipped: result.skipped }
}
