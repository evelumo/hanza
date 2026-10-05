import { describe, expect, it } from 'vitest'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { user } from '../testing/fixtures'
import {
  addProductToFamily,
  createFamily,
  deleteFamily,
  getFamily,
  listFamilies,
  listFamilyOptions,
  removeProductFromFamily,
  renameFamily,
  updateFamilyMember,
} from './families'
import { createProduct, getProduct, listProducts } from './products'

describe.skipIf(!databaseUrl)('product families', () => {
  const context = useTestContext()

  async function setup() {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const family = (await createFamily(ctx, org, { name: 'T-shirt', attributes: ['Size', 'Colour'] }, user)).familyId
    const product = async (sku: string, stock = 0) => (await createProduct(ctx, org, { sku, name: sku, stock }, user)).productId
    return { ctx, org, family, product }
  }

  it('creates a family and lists it with its attributes and member count', async () => {
    const { ctx, org, family, product } = await setup()
    const shirt = await product('TS-M-RED', 4)
    await addProductToFamily(ctx, org, family, shirt, { Size: 'M', Colour: 'Red' }, user)

    expect(await getFamily(ctx, org, family)).toEqual({
      id: family,
      name: 'T-shirt',
      attributes: ['Size', 'Colour'],
      members: [{ productId: shirt, sku: 'TS-M-RED', name: 'TS-M-RED', values: { Size: 'M', Colour: 'Red' }, available: 4 }],
    })
    expect(await listFamilies(ctx, org, { skip: 0, take: 10 })).toEqual({
      total: 1,
      items: [{ id: family, name: 'T-shirt', attributes: ['Size', 'Colour'], productCount: 1 }],
    })
    expect(await listFamilies(ctx, org, { search: 'mug', skip: 0, take: 10 })).toEqual({ total: 0, items: [] })
    expect(await listFamilyOptions(ctx, org)).toEqual([{ id: family, name: 'T-shirt' }])
    const events = await ctx.db.eventLog.findMany({ where: { organizationId: org, subjectType: 'product_family' }, orderBy: { id: 'asc' } })
    expect(events.map((event) => [event.type, event.subjectId])).toEqual([
      ['family.created', family],
      ['family.product_added', family],
    ])
    expect(events[0]?.payload).toEqual({ name: 'T-shirt', attributes: ['Size', 'Colour'], actor: user })
  })

  it('refuses bad names and attribute lists', async () => {
    const { ctx, org } = await setup()
    await expect(createFamily(ctx, org, { name: ' ', attributes: ['Size'] }, user)).rejects.toThrow(RangeError)
    for (const attributes of [[], ['Size', 'size'], ['', 'Size'], ['a', 'b', 'c', 'd', 'e', 'f']]) {
      await expect(createFamily(ctx, org, { name: 'X', attributes }, user)).rejects.toMatchObject({ code: 'invalid_attributes' })
    }
  })

  it('refuses a duplicate attribute combination, ignoring case and spacing, and allows it again once freed', async () => {
    const { ctx, org, family, product } = await setup()
    const a = await product('A')
    const b = await product('B')
    const c = await product('C')
    await addProductToFamily(ctx, org, family, a, { Size: 'M', Colour: 'Red' }, user)

    await expect(addProductToFamily(ctx, org, family, b, { Size: ' m ', Colour: 'RED' }, user)).rejects.toMatchObject({ code: 'variant_taken' })
    // Same size, another colour is a different combination.
    await addProductToFamily(ctx, org, family, b, { Size: 'M', Colour: 'Blue' }, user)
    // Editing into an existing combination is refused too, and nothing changed.
    await expect(updateFamilyMember(ctx, org, b, { Size: 'm', Colour: 'red' }, user)).rejects.toMatchObject({ code: 'variant_taken' })
    expect((await getFamily(ctx, org, family))?.members.map((member) => member.values)).toEqual([
      { Size: 'M', Colour: 'Red' },
      { Size: 'M', Colour: 'Blue' },
    ])

    await removeProductFromFamily(ctx, org, a, user)
    await addProductToFamily(ctx, org, family, c, { Size: 'M', Colour: 'Red' }, user)
    // Another family may use the same combination.
    const other = (await createFamily(ctx, org, { name: 'Hoodie', attributes: ['Size', 'Colour'] }, user)).familyId
    await addProductToFamily(ctx, org, other, a, { Size: 'M', Colour: 'Red' }, user)
  })

  it('refuses missing, empty and unknown attribute values, and a Product that is in a family already', async () => {
    const { ctx, org, family, product } = await setup()
    const a = await product('A')
    const invalidValues: Array<Record<string, string>> = [{ Size: 'M' }, { Size: 'M', Colour: ' ' }, { Size: 'M', Colour: 'Red', Material: 'x' }, {}]
    for (const values of invalidValues) {
      await expect(addProductToFamily(ctx, org, family, a, values, user)).rejects.toMatchObject({ code: 'invalid_attributes' })
    }
    expect((await getProduct(ctx, org, a))?.family).toBeNull()

    await addProductToFamily(ctx, org, family, a, { Size: 'M', Colour: 'Red' }, user)
    await expect(addProductToFamily(ctx, org, family, a, { Size: 'L', Colour: 'Red' }, user)).rejects.toMatchObject({ code: 'already_in_family' })
    const other = (await createFamily(ctx, org, { name: 'Hoodie', attributes: ['Size'] }, user)).familyId
    await expect(addProductToFamily(ctx, org, other, a, { Size: 'L' }, user)).rejects.toMatchObject({ code: 'already_in_family' })
    await expect(updateFamilyMember(ctx, org, a, { Size: 'M' }, user)).rejects.toMatchObject({ code: 'invalid_attributes' })
  })

  it('does not let two concurrent adds put the same combination or the same Product twice', async () => {
    const { ctx, org, family, product } = await setup()
    const [a, b] = [await product('A'), await product('B')]
    const same = await Promise.allSettled([
      addProductToFamily(ctx, org, family, a, { Size: 'M', Colour: 'Red' }, user),
      addProductToFamily(ctx, org, family, b, { Size: 'M', Colour: 'Red' }, user),
    ])
    expect(same.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect((same.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'variant_taken' })

    const other = (await createFamily(ctx, org, { name: 'Hoodie', attributes: ['Size'] }, user)).familyId
    const c = await product('C')
    const twice = await Promise.allSettled([
      addProductToFamily(ctx, org, family, c, { Size: 'S', Colour: 'Red' }, user),
      addProductToFamily(ctx, org, other, c, { Size: 'S' }, user),
    ])
    expect(twice.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect((twice.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'already_in_family' })
  })

  it('rejects another organization\'s family or Product as not found, and the database refuses a cross-tenant membership', async () => {
    const { ctx, org, family, product } = await setup()
    const mine = await product('MINE')
    await addProductToFamily(ctx, org, family, mine, { Size: 'M', Colour: 'Red' }, user)
    const other = await createTestOrganization(ctx.db)
    const theirs = (await createProduct(ctx, other, { sku: 'THEIRS', name: 'Theirs', stock: 1 }, user)).productId
    const theirFamily = (await createFamily(ctx, other, { name: 'Theirs', attributes: ['Size'] }, user)).familyId
    const values = { Size: 'M', Colour: 'Red' }
    const notFound = { code: 'not_found' }

    await expect(addProductToFamily(ctx, other, family, theirs, values, user)).rejects.toMatchObject(notFound)
    await expect(addProductToFamily(ctx, org, family, theirs, values, user)).rejects.toMatchObject(notFound)
    await expect(addProductToFamily(ctx, org, theirFamily, mine, { Size: 'M' }, user)).rejects.toMatchObject(notFound)
    await expect(updateFamilyMember(ctx, other, mine, { Size: 'L' }, user)).rejects.toMatchObject(notFound)
    await expect(removeProductFromFamily(ctx, other, mine, user)).rejects.toMatchObject(notFound)
    await expect(renameFamily(ctx, other, family, 'Hijacked', user)).rejects.toMatchObject(notFound)
    await expect(deleteFamily(ctx, other, family, user)).rejects.toMatchObject(notFound)
    expect(await getFamily(ctx, other, family)).toBeNull()
    expect((await listFamilies(ctx, other, { skip: 0, take: 10 })).items.map((item) => item.id)).toEqual([theirFamily])
    expect((await getFamily(ctx, org, family))?.name).toBe('T-shirt')
    expect((await getFamily(ctx, org, family))?.members).toHaveLength(1)

    // Even a bypass of the services cannot join a family of another organization.
    await expect(ctx.db.product.update({ where: { id: theirs }, data: { familyId: family, attributeValues: values, attributeKey: 'k' } })).rejects.toThrow()
    // A Product is in a family exactly when it has its values.
    await expect(ctx.db.product.update({ where: { id: mine }, data: { attributeKey: null } })).rejects.toThrow()
  })

  it('renames a family and edits and removes members, each with an Event', async () => {
    const { ctx, org, family, product } = await setup()
    const a = await product('A', 2)
    await addProductToFamily(ctx, org, family, a, { Size: 'M', Colour: 'Red' }, user)

    await renameFamily(ctx, org, family, ' Long sleeve ', user)
    await renameFamily(ctx, org, family, 'Long sleeve', user)
    await updateFamilyMember(ctx, org, a, { Size: 'L', Colour: 'Red' }, user)
    await updateFamilyMember(ctx, org, a, { Size: 'l', Colour: 'Red' }, user)
    expect((await getProduct(ctx, org, a))?.family).toEqual({
      id: family,
      name: 'Long sleeve',
      attributes: [
        { name: 'Size', value: 'l' },
        { name: 'Colour', value: 'Red' },
      ],
    })
    await removeProductFromFamily(ctx, org, a, user)
    await expect(removeProductFromFamily(ctx, org, a, user)).rejects.toMatchObject({ code: 'not_found' })
    await expect(updateFamilyMember(ctx, org, a, { Size: 'S', Colour: 'Red' }, user)).rejects.toMatchObject({ code: 'not_found' })
    expect(await ctx.db.product.findFirstOrThrow({ where: { id: a } })).toMatchObject({ familyId: null, attributeValues: null, attributeKey: null })

    const events = await ctx.db.eventLog.findMany({ where: { organizationId: org, subjectId: family }, orderBy: { id: 'asc' } })
    expect(events.map((event) => event.type)).toEqual([
      'family.created',
      'family.product_added',
      'family.renamed',
      'family.product_updated',
      'family.product_updated',
      'family.product_removed',
    ])
    expect(events[2]?.payload).toEqual({ name: { from: 'T-shirt', to: 'Long sleeve' }, actor: user })
  })

  it('deleting a family ungroups its Products and never deletes them or touches their Stock', async () => {
    const { ctx, org, family, product } = await setup()
    const a = await product('A', 5)
    const b = await product('B', 6)
    await addProductToFamily(ctx, org, family, a, { Size: 'M', Colour: 'Red' }, user)
    await addProductToFamily(ctx, org, family, b, { Size: 'L', Colour: 'Red' }, user)
    const stockBefore = await ctx.db.stock.findMany({ where: { organizationId: org }, orderBy: { productId: 'asc' } })

    await deleteFamily(ctx, org, family, user)

    expect(await getFamily(ctx, org, family)).toBeNull()
    expect(await ctx.db.productFamily.count({ where: { organizationId: org } })).toBe(0)
    const products = await ctx.db.product.findMany({ where: { organizationId: org }, orderBy: { sku: 'asc' } })
    expect(products.map((item) => [item.sku, item.familyId, item.attributeValues, item.attributeKey])).toEqual([
      ['A', null, null, null],
      ['B', null, null, null],
    ])
    expect(await ctx.db.stock.findMany({ where: { organizationId: org }, orderBy: { productId: 'asc' } })).toEqual(stockBefore)
    const [event] = await ctx.db.eventLog.findMany({ where: { organizationId: org, type: 'family.deleted' } })
    expect(event).toMatchObject({ subjectType: 'product_family', subjectId: family, payload: { name: 'T-shirt', ungrouped: [a, b].sort(), actor: user } })
    await expect(deleteFamily(ctx, org, family, user)).rejects.toMatchObject({ code: 'not_found' })
    // The freed Products can join a new family.
    const again = (await createFamily(ctx, org, { name: 'Again', attributes: ['Size', 'Colour'] }, user)).familyId
    await addProductToFamily(ctx, org, again, a, { Size: 'M', Colour: 'Red' }, user)
  })

  it('lists Products with their family, and filters by family or by no family', async () => {
    const { ctx, org, family, product } = await setup()
    const [a, b, c] = [await product('A'), await product('B'), await product('C')]
    await addProductToFamily(ctx, org, family, a, { Size: 'M', Colour: 'Red' }, user)
    await addProductToFamily(ctx, org, family, b, { Size: 'L', Colour: 'Red' }, user)

    const all = await listProducts(ctx, org, { skip: 0, take: 10 })
    expect(all.items.map((item) => [item.sku, item.family?.name ?? null, item.family?.attributes.map((attribute) => attribute.value) ?? null])).toEqual([
      ['A', 'T-shirt', ['M', 'Red']],
      ['B', 'T-shirt', ['L', 'Red']],
      ['C', null, null],
    ])
    expect((await listProducts(ctx, org, { family: { id: family }, skip: 0, take: 10 })).items.map((item) => item.id)).toEqual([a, b])
    expect((await listProducts(ctx, org, { family: 'none', skip: 0, take: 10 })).items.map((item) => item.id)).toEqual([c])
    const other = await createTestOrganization(ctx.db)
    expect(await listProducts(ctx, other, { family: { id: family }, skip: 0, take: 10 })).toEqual({ total: 0, items: [] })
  })
})
