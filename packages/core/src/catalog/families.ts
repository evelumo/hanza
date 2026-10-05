import { Prisma, type Tx } from '@hanza/db'
import type { Actor } from '../actor'
import type { Context } from '../context'
import { DomainError, isUniqueViolation } from '../errors'
import { appendEvent } from '../events'
import { getAvailability } from '../stock/availability'
import { TX_OPTIONS } from '../transaction'
import { normalizeAttributeNames, normalizeAttributeValues } from './family-attributes'

/**
 * A Product family only groups Products. Nothing here reads or writes Stock, Reservations, Orders or Offers: they keep
 * pointing at the Products, which stay what they were.
 */

export interface FamilyRow {
  id: string
  name: string
  attributes: string[]
  productCount: number
}

export interface FamilyMember {
  productId: string
  sku: string
  name: string
  /** One value per attribute of the family. */
  values: Record<string, string>
  available: number
}

export interface FamilyDetail {
  id: string
  name: string
  attributes: string[]
  members: FamilyMember[]
}

function requireName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new RangeError('Family name must not be empty')
  return trimmed
}

/** Serialises changes to one family's members against its deletion, so a Product never joins a family that is going away. */
async function lockFamily(tx: Tx, organizationId: string, familyId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "product_family" WHERE "id" = ${familyId} AND "organizationId" = ${organizationId} FOR UPDATE`
  return rows.length > 0
}

const valuesOf = (json: Prisma.JsonValue | null): Record<string, string> => (json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, string>) : {})

export async function createFamily(
  ctx: Context,
  organizationId: string,
  input: { name: string; attributes: string[] },
  actor: Actor,
): Promise<{ familyId: string }> {
  const name = requireName(input.name)
  const attributes = normalizeAttributeNames(input.attributes)
  return ctx.db.$transaction(async (tx) => {
    const family = await tx.productFamily.create({ data: { organizationId, name, attributes }, select: { id: true } })
    await appendEvent(tx, {
      organizationId,
      type: 'family.created',
      subject: { type: 'product_family', id: family.id },
      payload: { name, attributes, actor },
    })
    return { familyId: family.id }
  }, TX_OPTIONS)
}

export async function renameFamily(ctx: Context, organizationId: string, familyId: string, name: string, actor: Actor): Promise<void> {
  const next = requireName(name)
  await ctx.db.$transaction(async (tx) => {
    const family = await tx.productFamily.findFirst({ where: { id: familyId, organizationId }, select: { name: true } })
    if (!family) throw new DomainError('not_found')
    if (family.name === next) return
    await tx.productFamily.updateMany({ where: { id: familyId, organizationId }, data: { name: next } })
    await appendEvent(tx, {
      organizationId,
      type: 'family.renamed',
      subject: { type: 'product_family', id: familyId },
      payload: { name: { from: family.name, to: next }, actor },
    })
  }, TX_OPTIONS)
}

/** Ungroups the family's Products and deletes the family. The Products themselves are never deleted or changed otherwise. */
export async function deleteFamily(ctx: Context, organizationId: string, familyId: string, actor: Actor): Promise<void> {
  await ctx.db.$transaction(async (tx) => {
    if (!(await lockFamily(tx, organizationId, familyId))) throw new DomainError('not_found')
    const family = await tx.productFamily.findFirstOrThrow({ where: { id: familyId, organizationId }, select: { name: true } })
    const ungrouped = await tx.product.updateManyAndReturn({
      where: { organizationId, familyId },
      data: { familyId: null, attributeValues: Prisma.DbNull, attributeKey: null },
      select: { id: true },
    })
    await tx.productFamily.deleteMany({ where: { id: familyId, organizationId } })
    await appendEvent(tx, {
      organizationId,
      type: 'family.deleted',
      subject: { type: 'product_family', id: familyId },
      payload: { name: family.name, ungrouped: ungrouped.map((product) => product.id).sort(), actor },
    })
  }, TX_OPTIONS)
}

/**
 * Puts a Product into a family with one value per attribute. Refused with `already_in_family` when the Product is in one
 * (edit its values, or remove it first) and with `variant_taken` when another Product of the family has the same values.
 */
export async function addProductToFamily(
  ctx: Context,
  organizationId: string,
  familyId: string,
  productId: string,
  values: Record<string, string>,
  actor: Actor,
): Promise<void> {
  await ctx.db.$transaction(async (tx) => {
    if (!(await lockFamily(tx, organizationId, familyId))) throw new DomainError('not_found')
    const family = await tx.productFamily.findFirstOrThrow({ where: { id: familyId, organizationId }, select: { attributes: true } })
    const product = await tx.product.findFirst({ where: { id: productId, organizationId }, select: { sku: true, familyId: true } })
    if (!product) throw new DomainError('not_found')
    if (product.familyId !== null) throw new DomainError('already_in_family')
    const normalized = normalizeAttributeValues(family.attributes, values)

    let joined: { count: number }
    try {
      joined = await tx.product.updateMany({
        where: { id: productId, organizationId, familyId: null },
        data: { familyId, attributeValues: normalized.values, attributeKey: normalized.key },
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainError('variant_taken')
      throw error
    }
    if (joined.count === 0) throw new DomainError('already_in_family')
    await appendEvent(tx, {
      organizationId,
      type: 'family.product_added',
      subject: { type: 'product_family', id: familyId },
      payload: { productId, sku: product.sku, values: normalized.values, actor },
    })
  }, TX_OPTIONS)
}

/** Changes the attribute values of a Product that is in a family. */
export async function updateFamilyMember(
  ctx: Context,
  organizationId: string,
  productId: string,
  values: Record<string, string>,
  actor: Actor,
): Promise<void> {
  await ctx.db.$transaction(async (tx) => {
    const product = await tx.product.findFirst({
      where: { id: productId, organizationId, familyId: { not: null } },
      select: { sku: true, familyId: true, attributeValues: true, attributeKey: true, family: { select: { attributes: true } } },
    })
    if (!product?.familyId || !product.family) throw new DomainError('not_found')
    const normalized = normalizeAttributeValues(product.family.attributes, values)
    if (normalized.key === product.attributeKey && JSON.stringify(normalized.values) === JSON.stringify(valuesOf(product.attributeValues))) return

    let updated: { count: number }
    try {
      // `familyId` in the filter: a family deleted meanwhile ungroups the Product, which then simply is not found.
      updated = await tx.product.updateMany({
        where: { id: productId, organizationId, familyId: product.familyId },
        data: { attributeValues: normalized.values, attributeKey: normalized.key },
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainError('variant_taken')
      throw error
    }
    if (updated.count === 0) throw new DomainError('not_found')
    await appendEvent(tx, {
      organizationId,
      type: 'family.product_updated',
      subject: { type: 'product_family', id: product.familyId },
      payload: { productId, sku: product.sku, values: { from: valuesOf(product.attributeValues), to: normalized.values }, actor },
    })
  }, TX_OPTIONS)
}

export async function removeProductFromFamily(ctx: Context, organizationId: string, productId: string, actor: Actor): Promise<void> {
  await ctx.db.$transaction(async (tx) => {
    const product = await tx.product.findFirst({
      where: { id: productId, organizationId, familyId: { not: null } },
      select: { sku: true, familyId: true, attributeValues: true },
    })
    if (!product?.familyId) throw new DomainError('not_found')
    const removed = await tx.product.updateMany({
      where: { id: productId, organizationId, familyId: product.familyId },
      data: { familyId: null, attributeValues: Prisma.DbNull, attributeKey: null },
    })
    if (removed.count === 0) throw new DomainError('not_found')
    await appendEvent(tx, {
      organizationId,
      type: 'family.product_removed',
      subject: { type: 'product_family', id: product.familyId },
      payload: { productId, sku: product.sku, values: valuesOf(product.attributeValues), actor },
    })
  }, TX_OPTIONS)
}

export async function listFamilies(
  ctx: Context,
  organizationId: string,
  query: { search?: string; skip: number; take: number },
): Promise<{ total: number; items: FamilyRow[] }> {
  const search = query.search?.trim()
  const where = { organizationId, ...(search ? { name: { contains: search, mode: 'insensitive' as const } } : {}) }
  const [total, families] = await Promise.all([
    ctx.db.productFamily.count({ where }),
    ctx.db.productFamily.findMany({
      where,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      skip: query.skip,
      take: query.take,
      select: { id: true, name: true, attributes: true, _count: { select: { products: true } } },
    }),
  ])
  return {
    total,
    items: families.map((family) => ({ id: family.id, name: family.name, attributes: family.attributes, productCount: family._count.products })),
  }
}

/** Every family of the organization, for pickers (the Products filter). Families are few, so no paging. */
export async function listFamilyOptions(ctx: Context, organizationId: string): Promise<Array<{ id: string; name: string }>> {
  return ctx.db.productFamily.findMany({
    where: { organizationId },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    take: 500,
    select: { id: true, name: true },
  })
}

export async function getFamily(ctx: Context, organizationId: string, familyId: string): Promise<FamilyDetail | null> {
  const family = await ctx.db.productFamily.findFirst({
    where: { id: familyId, organizationId },
    select: {
      id: true,
      name: true,
      attributes: true,
      products: {
        where: { organizationId },
        orderBy: { sku: 'asc' },
        select: { id: true, sku: true, name: true, attributeValues: true },
      },
    },
  })
  if (!family) return null
  const availability = await getAvailability(ctx.db, organizationId, family.products.map((product) => product.id))
  return {
    id: family.id,
    name: family.name,
    attributes: family.attributes,
    members: family.products.map((product) => ({
      productId: product.id,
      sku: product.sku,
      name: product.name,
      values: valuesOf(product.attributeValues),
      available: availability.get(product.id)?.available ?? 0,
    })),
  }
}
