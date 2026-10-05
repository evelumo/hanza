import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { Actor } from '../actor'
import { createProduct } from '../catalog/products'
import { changeOrderStatus } from '../orders/change-status'
import { importOrder } from '../orders/import'
import { getOrder, listOrders } from '../orders/queries'
import { getAvailability } from '../stock/availability'
import { createTestOrganization, type TestContext } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, createTestConnection, fact, orderLine, testChannel } from '../testing/fixtures'
import { deleteOrderStatus } from './delete'
import { getStatusMapping, setStatusMapping } from './mapping'
import {
  createOrderStatus,
  listOrderStatuses,
  makeDefaultOrderStatus,
  moveOrderStatus,
  setOrderStatusActive,
  updateOrderStatus,
} from './statuses'

async function addMember(ctx: TestContext, organizationId: string, role: string): Promise<Actor> {
  const userId = randomUUID()
  await ctx.db.user.create({ data: { id: userId, name: role, email: `${userId}@example.org` } })
  await ctx.db.member.create({ data: { id: randomUUID(), organizationId, userId, role, createdAt: new Date() } })
  return { type: 'user', userId }
}

describe.skipIf(!databaseUrl)('Order statuses (Postgres)', () => {
  const context = useTestContext({ connectors: [testChannel] })

  async function setup() {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const admin = await addMember(ctx, org, 'admin')
    const connectionId = await createTestConnection(ctx, org)
    const statuses = async () => listOrderStatuses(ctx, org)
    const defaultOf = async (phase: string) => (await statuses()).find((status) => status.phase === phase && status.isDefault)!
    const stored = (orderId: string) =>
      ctx.db.order.findFirstOrThrow({ where: { id: orderId, organizationId: org }, include: { status: true, lines: { include: { reservation: true } } } })
    return { ctx, org, admin, connectionId, statuses, defaultOf, stored }
  }

  it('gives every organization one default status per phase, named after the phase, once', async () => {
    const { ctx, org, statuses } = await setup()
    await Promise.all(Array.from({ length: 5 }, () => listOrderStatuses(ctx, org)))
    expect((await statuses()).map((status) => [status.phase, status.name, status.isDefault, status.active])).toEqual([
      ['new', null, true, true],
      ['processing', null, true, true],
      ['shipped', null, true, true],
      ['cancelled', null, true, true],
    ])
  })

  it('lets only owners and admins manage statuses and Status mappings; anyone may change an Order status', async () => {
    const { ctx, org, admin, connectionId, defaultOf } = await setup()
    const member = await addMember(ctx, org, 'member')
    const owner = await addMember(ctx, org, 'member,owner')
    const forbidden = { code: 'forbidden' }
    await expect(createOrderStatus(ctx, org, { phase: 'processing', name: 'Packing', color: null }, member)).rejects.toMatchObject(forbidden)
    await expect(createOrderStatus(ctx, org, { phase: 'processing', name: 'Packing', color: null }, { type: 'user', userId: 'stranger' })).rejects.toMatchObject(forbidden)
    const { statusId } = await createOrderStatus(ctx, org, { phase: 'processing', name: 'Packing', color: 'amber' }, owner)
    await expect(updateOrderStatus(ctx, org, statusId, { name: 'Packed', color: null }, member)).rejects.toMatchObject(forbidden)
    await expect(moveOrderStatus(ctx, org, statusId, 'up', member)).rejects.toMatchObject(forbidden)
    await expect(setOrderStatusActive(ctx, org, statusId, false, member)).rejects.toMatchObject(forbidden)
    await expect(makeDefaultOrderStatus(ctx, org, statusId, member)).rejects.toMatchObject(forbidden)
    await expect(deleteOrderStatus(ctx, org, statusId, null, member)).rejects.toMatchObject(forbidden)
    await expect(setStatusMapping(ctx, org, connectionId, { new: (await defaultOf('new')).id }, member)).rejects.toMatchObject(forbidden)

    const { orderId } = await importOrder(ctx, org, connectionId, buildOrder())
    await changeOrderStatus(ctx, org, orderId, { statusId }, member)
    await updateOrderStatus(ctx, org, statusId, { name: 'Packed', color: null }, admin)
  })

  it('creates, renames, recolours, reorders, deactivates and makes a status the default, with Events', async () => {
    const { ctx, org, admin, statuses, defaultOf } = await setup()
    const packing = (await createOrderStatus(ctx, org, { phase: 'processing', name: '  Packing ', color: 'amber' }, admin)).statusId
    const packed = (await createOrderStatus(ctx, org, { phase: 'processing', name: 'Packed', color: null }, admin)).statusId
    const processing = () => statuses().then((all) => all.filter((status) => status.phase === 'processing').map((status) => status.name))
    expect(await processing()).toEqual([null, 'Packing', 'Packed'])

    await expect(createOrderStatus(ctx, org, { phase: 'shipped', name: 'PACKED', color: null }, admin)).rejects.toMatchObject({ code: 'status_name_taken' })
    await expect(updateOrderStatus(ctx, org, packing, { name: 'packed', color: null }, admin)).rejects.toMatchObject({ code: 'status_name_taken' })

    await moveOrderStatus(ctx, org, packed, 'up', admin)
    expect(await processing()).toEqual([null, 'Packed', 'Packing'])
    await moveOrderStatus(ctx, org, packed, 'up', admin)
    await moveOrderStatus(ctx, org, packed, 'up', admin)
    expect(await processing()).toEqual(['Packed', null, 'Packing'])

    await updateOrderStatus(ctx, org, packing, { name: 'Waiting for packaging', color: 'violet' }, admin)
    expect((await statuses()).find((status) => status.id === packing)).toMatchObject({ name: 'Waiting for packaging', color: 'violet' })
    await updateOrderStatus(ctx, org, packing, { name: '', color: null }, admin)
    expect((await statuses()).find((status) => status.id === packing)).toMatchObject({ name: null, color: null })

    const processingDefault = await defaultOf('processing')
    await expect(setOrderStatusActive(ctx, org, processingDefault.id, false, admin)).rejects.toMatchObject({ code: 'status_is_default' })
    await setOrderStatusActive(ctx, org, packed, false, admin)
    await expect(makeDefaultOrderStatus(ctx, org, packed, admin)).rejects.toMatchObject({ code: 'status_inactive' })
    const again = (await createOrderStatus(ctx, org, { phase: 'processing', name: 'Packed', color: null }, admin)).statusId
    await expect(setOrderStatusActive(ctx, org, packed, true, admin)).rejects.toMatchObject({ code: 'status_name_taken' })

    await makeDefaultOrderStatus(ctx, org, again, admin)
    const after = await statuses()
    expect(after.filter((status) => status.phase === 'processing' && status.isDefault).map((status) => status.id)).toEqual([again])
    expect(after.find((status) => status.id === processingDefault.id)?.isDefault).toBe(false)

    const events = await ctx.db.eventLog.findMany({ where: { organizationId: org, subjectType: 'order_status' }, orderBy: { id: 'asc' } })
    expect(events.map((event) => event.type)).toEqual([
      'order_status.created',
      'order_status.created',
      'order_status.updated',
      'order_status.updated',
      'order_status.updated',
      'order_status.updated',
      'order_status.updated',
      'order_status.created',
      'order_status.updated',
    ])
    expect(events[0]?.payload).toEqual({ phase: 'processing', name: 'Packing', color: 'amber', actor: admin })
  })

  it('moves an Order within a phase without touching Stock or the status push, and keeps final phases final', async () => {
    const { ctx, org, admin, connectionId, stored } = await setup()
    const { productId } = await createProduct(ctx, org, { sku: 'P', name: 'Product', stock: 5 }, admin)
    const packing = (await createOrderStatus(ctx, org, { phase: 'processing', name: 'Packing', color: null }, admin)).statusId
    const packed = (await createOrderStatus(ctx, org, { phase: 'processing', name: 'Packed', color: null }, admin)).statusId
    const delivered = (await createOrderStatus(ctx, org, { phase: 'shipped', name: 'Delivered', color: null }, admin)).statusId
    const { orderId } = await importOrder(ctx, org, connectionId, buildOrder({ lines: [orderLine('l1', { sku: 'P', quantity: 2 })] }))
    // Counted at the call: the in-memory queue drops a request coalesced into one still waiting.
    let requested = 0
    const enqueue = ctx.queue.enqueue
    ctx.queue.enqueue = async (job, payload, options) => {
      if (job.name === 'orders.updateStatus' && (payload as { orderId: string }).orderId === orderId) requested++
      return enqueue(job, payload, options)
    }
    onTestFinished(() => {
      ctx.queue.enqueue = enqueue
    })
    const pushes = () => requested

    await changeOrderStatus(ctx, org, orderId, { statusId: packing }, admin)
    const afterPhaseChange = await stored(orderId)
    expect(afterPhaseChange).toMatchObject({ phase: 'processing', statusId: packing, statusPushSeq: 1 })
    expect(pushes()).toBe(1)

    await changeOrderStatus(ctx, org, orderId, { statusId: packed }, admin)
    const afterMove = await stored(orderId)
    expect(afterMove).toMatchObject({ phase: 'processing', statusId: packed, statusPushSeq: 1, statusPushDueAt: afterPhaseChange.statusPushDueAt })
    expect(afterMove.lines[0]?.reservation?.status).toBe('open')
    expect(pushes()).toBe(1)
    expect((await getAvailability(ctx.db, org, [productId])).get(productId)).toEqual({ stock: 5, reserved: 2, available: 3 })

    await expect(changeOrderStatus(ctx, org, orderId, { statusId: packed }, admin)).rejects.toMatchObject({ code: 'invalid_transition' })
    await setOrderStatusActive(ctx, org, packing, false, admin)
    await expect(changeOrderStatus(ctx, org, orderId, { statusId: packing }, admin)).rejects.toMatchObject({ code: 'invalid_transition' })

    await changeOrderStatus(ctx, org, orderId, 'shipped', admin)
    expect((await stored(orderId)).statusPushSeq).toBe(2)
    expect(pushes()).toBe(2)
    expect((await getAvailability(ctx.db, org, [productId])).get(productId)).toEqual({ stock: 3, reserved: 0, available: 3 })
    await changeOrderStatus(ctx, org, orderId, { statusId: delivered }, admin)
    expect(await stored(orderId)).toMatchObject({ phase: 'shipped', statusId: delivered, statusPushSeq: 2 })
    expect(pushes()).toBe(2)
    await expect(changeOrderStatus(ctx, org, orderId, 'processing', admin)).rejects.toMatchObject({ code: 'invalid_transition' })
    expect((await getAvailability(ctx.db, org, [productId])).get(productId)).toEqual({ stock: 3, reserved: 0, available: 3 })

    // Renaming a status afterwards never rewrites history: the Events keep the name it had.
    await updateOrderStatus(ctx, org, packed, { name: 'Boxed', color: null }, admin)
    const changes = await ctx.db.eventLog.findMany({ where: { organizationId: org, subjectId: orderId, type: 'order.status_changed' }, orderBy: { id: 'asc' } })
    expect(changes[1]?.payload).toMatchObject({
      from: 'processing',
      to: 'processing',
      fromStatus: { id: packing, name: 'Packing' },
      toStatus: { id: packed, name: 'Packed' },
      cause: 'user',
    })
    expect((await getOrder(ctx, org, orderId))?.status).toEqual({ id: delivered, name: 'Delivered', color: null, phase: 'shipped' })
  })

  it('lists and filters Orders by phase and by status, and offers the allowed statuses grouped by phase', async () => {
    const { ctx, org, admin, connectionId, defaultOf } = await setup()
    const packing = (await createOrderStatus(ctx, org, { phase: 'processing', name: 'Packing', color: 'amber' }, admin)).statusId
    const a = await importOrder(ctx, org, connectionId, buildOrder())
    const b = await importOrder(ctx, org, connectionId, buildOrder())
    await changeOrderStatus(ctx, org, a.orderId, { statusId: packing }, admin)
    await changeOrderStatus(ctx, org, b.orderId, 'processing', admin)

    const ids = async (query: { phase?: 'processing'; statusId?: string }) =>
      (await listOrders(ctx, org, { ...query, skip: 0, take: 10 })).items.map((row) => row.id).sort()
    expect(await ids({ phase: 'processing' })).toEqual([a.orderId, b.orderId].sort())
    expect(await ids({ statusId: packing })).toEqual([a.orderId])
    expect(await ids({ statusId: (await defaultOf('processing')).id })).toEqual([b.orderId])
    expect((await listOrders(ctx, org, { statusId: packing, skip: 0, take: 10 })).items[0]?.status).toEqual({
      id: packing,
      name: 'Packing',
      color: 'amber',
      phase: 'processing',
    })
    const detail = await getOrder(ctx, org, a.orderId)
    expect(detail?.allowedStatuses.map((status) => [status.phase, status.name])).toEqual([
      ['new', null],
      ['processing', null],
      ['shipped', null],
      ['cancelled', null],
    ])
  })

  it('deletes a status: never a default, only with an active replacement of its phase while in use, moving Orders in batches', async () => {
    const { ctx, org, admin, connectionId, statuses, defaultOf, stored } = await setup()
    const packing = (await createOrderStatus(ctx, org, { phase: 'processing', name: 'Packing', color: null }, admin)).statusId
    const packed = (await createOrderStatus(ctx, org, { phase: 'processing', name: 'Packed', color: null }, admin)).statusId
    const unused = (await createOrderStatus(ctx, org, { phase: 'processing', name: 'Unused', color: null }, admin)).statusId
    const delivered = (await createOrderStatus(ctx, org, { phase: 'shipped', name: 'Delivered', color: null }, admin)).statusId
    const orderIds: string[] = []
    for (let i = 0; i < 5; i++) {
      const { orderId } = await importOrder(ctx, org, connectionId, buildOrder())
      await changeOrderStatus(ctx, org, orderId, { statusId: packing }, admin)
      orderIds.push(orderId)
    }
    const otherConnection = await createTestConnection(ctx, org, 'Other channel')
    await setStatusMapping(ctx, org, otherConnection, { new: (await defaultOf('new')).id }, admin)

    await expect(deleteOrderStatus(ctx, org, (await defaultOf('processing')).id, packed, admin)).rejects.toMatchObject({ code: 'status_is_default' })
    await expect(deleteOrderStatus(ctx, org, packing, null, admin)).rejects.toMatchObject({ code: 'status_in_use' })
    await expect(deleteOrderStatus(ctx, org, packing, delivered, admin)).rejects.toMatchObject({ code: 'invalid_replacement' })
    await expect(deleteOrderStatus(ctx, org, packing, packing, admin)).rejects.toMatchObject({ code: 'invalid_replacement' })
    await setOrderStatusActive(ctx, org, packed, false, admin)
    await expect(deleteOrderStatus(ctx, org, packing, packed, admin)).rejects.toMatchObject({ code: 'invalid_replacement' })
    await setOrderStatusActive(ctx, org, packed, true, admin)
    expect((await statuses()).find((status) => status.id === packing)?.active).toBe(true)

    expect(await deleteOrderStatus(ctx, org, unused, null, admin)).toEqual({ moved: 0 })
    expect(await deleteOrderStatus(ctx, org, packing, packed, admin, { batchSize: 2 })).toEqual({ moved: 5 })

    expect((await statuses()).map((status) => status.id)).not.toContain(packing)
    for (const orderId of orderIds) expect(await stored(orderId)).toMatchObject({ phase: 'processing', statusId: packed, statusPushSeq: 1 })
    const moved = await ctx.db.eventLog.findMany({ where: { organizationId: org, type: 'order.status_changed', payload: { path: ['cause'], equals: 'status_deleted' } } })
    expect(moved.map((event) => event.subjectId).sort()).toEqual([...orderIds].sort())
    expect(moved[0]?.payload).toMatchObject({ from: 'processing', to: 'processing', fromStatus: { id: packing, name: 'Packing' }, toStatus: { id: packed, name: 'Packed' } })
    const deleted = await ctx.db.eventLog.findFirstOrThrow({ where: { organizationId: org, type: 'order_status.deleted', subjectId: packing } })
    expect(deleted.payload).toEqual({ phase: 'processing', name: 'Packing', replacement: { id: packed, name: 'Packed' }, moved: 5, actor: admin })
  })

  it('moves the Status mappings of a deleted status to its replacement', async () => {
    const { ctx, org, admin, connectionId } = await setup()
    const refunded = (await createOrderStatus(ctx, org, { phase: 'cancelled', name: 'Refunded', color: null }, admin)).statusId
    const returned = (await createOrderStatus(ctx, org, { phase: 'cancelled', name: 'Returned', color: null }, admin)).statusId
    await setStatusMapping(ctx, org, connectionId, { cancelled: refunded }, admin)
    await expect(deleteOrderStatus(ctx, org, refunded, null, admin)).rejects.toMatchObject({ code: 'status_in_use' })
    await deleteOrderStatus(ctx, org, refunded, returned, admin)
    expect(await getStatusMapping(ctx, org, connectionId)).toEqual({ new: null, shipped: null, cancelled: returned })
  })

  it('imports with the Connection\'s Status mapping, falls back to the default, and applies facts to the mapped status', async () => {
    const { ctx, org, admin, connectionId, defaultOf, stored } = await setup()
    const toCheck = (await createOrderStatus(ctx, org, { phase: 'new', name: 'To check', color: null }, admin)).statusId
    const refunded = (await createOrderStatus(ctx, org, { phase: 'cancelled', name: 'Refunded', color: null }, admin)).statusId
    const delivered = (await createOrderStatus(ctx, org, { phase: 'shipped', name: 'Delivered', color: null }, admin)).statusId
    const other = await createTestConnection(ctx, org, 'Other channel')

    await expect(setStatusMapping(ctx, org, connectionId, { new: refunded }, admin)).rejects.toMatchObject({ code: 'not_found' })
    await setStatusMapping(ctx, org, connectionId, { new: toCheck, cancelled: refunded }, admin)
    await setStatusMapping(ctx, org, connectionId, { new: toCheck }, admin)
    expect(await getStatusMapping(ctx, org, connectionId)).toEqual({ new: toCheck, shipped: null, cancelled: refunded })

    const order = buildOrder()
    const mapped = await importOrder(ctx, org, connectionId, order)
    const unmapped = await importOrder(ctx, org, other, buildOrder())
    expect((await stored(mapped.orderId)).statusId).toBe(toCheck)
    expect((await stored(unmapped.orderId)).statusId).toBe((await defaultOf('new')).id)

    await importOrder(ctx, org, connectionId, { ...order, facts: [fact('c', 'cancelled')] })
    expect(await stored(mapped.orderId)).toMatchObject({ phase: 'cancelled', statusId: refunded })

    await setOrderStatusActive(ctx, org, toCheck, false, admin)
    expect((await stored((await importOrder(ctx, org, connectionId, buildOrder())).orderId)).statusId).toBe((await defaultOf('new')).id)

    await setStatusMapping(ctx, org, connectionId, { shipped: delivered, cancelled: null }, admin)
    const shippedOrder = buildOrder()
    const { orderId } = await importOrder(ctx, org, connectionId, shippedOrder)
    await importOrder(ctx, org, connectionId, { ...shippedOrder, facts: [fact('s', 'shipped')] })
    expect(await stored(orderId)).toMatchObject({ phase: 'shipped', statusId: delivered })

    const events = await ctx.db.eventLog.findMany({ where: { organizationId: org, type: 'connection.status_mapping_changed' }, orderBy: { id: 'asc' } })
    expect(events.map((event) => event.payload)).toEqual([
      { phase: 'new', from: null, to: { id: toCheck, name: 'To check' }, actor: admin },
      { phase: 'cancelled', from: null, to: { id: refunded, name: 'Refunded' }, actor: admin },
      { phase: 'shipped', from: null, to: { id: delivered, name: 'Delivered' }, actor: admin },
      { phase: 'cancelled', from: { id: refunded, name: 'Refunded' }, to: null, actor: admin },
    ])
  })

  it('keeps every tenant to its own statuses and mappings', async () => {
    const { ctx, org: a, admin: adminA, connectionId: connectionA } = await setup()
    const { org: b, admin: adminB, connectionId: connectionB } = await setup()
    const statusA = (await createOrderStatus(ctx, a, { phase: 'processing', name: 'Packing', color: null }, adminA)).statusId
    const { orderId: orderB } = await importOrder(ctx, b, connectionB, buildOrder())
    const notFound = { code: 'not_found' }

    expect((await listOrderStatuses(ctx, b)).map((status) => status.id)).not.toContain(statusA)
    await expect(updateOrderStatus(ctx, b, statusA, { name: 'Mine', color: null }, adminB)).rejects.toMatchObject(notFound)
    await expect(moveOrderStatus(ctx, b, statusA, 'up', adminB)).rejects.toMatchObject(notFound)
    await expect(setOrderStatusActive(ctx, b, statusA, false, adminB)).rejects.toMatchObject(notFound)
    await expect(makeDefaultOrderStatus(ctx, b, statusA, adminB)).rejects.toMatchObject(notFound)
    await expect(deleteOrderStatus(ctx, b, statusA, null, adminB)).rejects.toMatchObject(notFound)
    await expect(changeOrderStatus(ctx, b, orderB, { statusId: statusA }, adminB)).rejects.toMatchObject(notFound)
    await expect(setStatusMapping(ctx, b, connectionB, { new: (await listOrderStatuses(ctx, a))[0]!.id }, adminB)).rejects.toMatchObject(notFound)
    await expect(setStatusMapping(ctx, b, connectionA, { new: null }, adminB)).rejects.toMatchObject(notFound)
    // An admin of A is nobody in B.
    await expect(createOrderStatus(ctx, b, { phase: 'new', name: 'X', color: null }, adminA)).rejects.toMatchObject({ code: 'forbidden' })
    expect((await ctx.db.orderStatus.findFirstOrThrow({ where: { id: statusA } })).name).toBe('Packing')
  })

  describe('database guarantees', () => {
    it('refuses an Order status of another organization or of another phase', async () => {
      const { ctx, org: a, admin, connectionId, defaultOf } = await setup()
      const { org: b, defaultOf: defaultOfB } = await setup()
      const { orderId } = await importOrder(ctx, a, connectionId, buildOrder())
      const packing = (await createOrderStatus(ctx, a, { phase: 'processing', name: 'Packing', color: null }, admin)).statusId
      void b

      const otherTenant = (await defaultOfB('new')).id
      await expect(ctx.db.$executeRaw`UPDATE "order" SET "statusId" = ${otherTenant} WHERE "id" = ${orderId}`).rejects.toThrow(/foreign key/i)
      await expect(ctx.db.$executeRaw`UPDATE "order" SET "statusId" = ${packing} WHERE "id" = ${orderId}`).rejects.toThrow(/foreign key/i)
      await expect(ctx.db.$executeRaw`UPDATE "order" SET "phase" = 'shipped' WHERE "id" = ${orderId}`).rejects.toThrow(/foreign key/i)
      await expect(
        ctx.db.$executeRaw`UPDATE "order" SET "phase" = 'processing', "statusId" = ${packing} WHERE "id" = ${orderId}`,
      ).resolves.toBe(1)
      await expect(ctx.db.$executeRaw`DELETE FROM "order_status" WHERE "id" = ${packing}`).rejects.toThrow(/foreign key/i)
      void (await defaultOf('new'))
    })

    it('keeps one active default per phase and Status mappings to reported phases of the same organization', async () => {
      const { ctx, org, admin, connectionId, defaultOf } = await setup()
      const packing = (await createOrderStatus(ctx, org, { phase: 'processing', name: 'Packing', color: null }, admin)).statusId
      await expect(ctx.db.$executeRaw`UPDATE "order_status" SET "isDefault" = true WHERE "id" = ${packing}`).rejects.toThrow(/unique/i)
      const processingDefault = (await defaultOf('processing')).id
      await expect(ctx.db.$executeRaw`UPDATE "order_status" SET "active" = false WHERE "id" = ${processingDefault}`).rejects.toThrow(/check/i)
      await expect(
        ctx.db.$executeRaw`INSERT INTO "channel_status_mapping" ("id", "organizationId", "connectionId", "phase", "statusId", "updatedAt")
          VALUES (gen_random_uuid()::text, ${org}, ${connectionId}, 'processing', ${packing}, now())`,
      ).rejects.toThrow(/check/i)
      await expect(
        ctx.db.$executeRaw`INSERT INTO "channel_status_mapping" ("id", "organizationId", "connectionId", "phase", "statusId", "updatedAt")
          VALUES (gen_random_uuid()::text, ${org}, ${connectionId}, 'new', ${packing}, now())`,
      ).rejects.toThrow(/foreign key/i)
      const { org: other } = await setup()
      const otherNew = (await listOrderStatuses(ctx, other)).find((status) => status.phase === 'new')!.id
      await expect(
        ctx.db.$executeRaw`INSERT INTO "channel_status_mapping" ("id", "organizationId", "connectionId", "phase", "statusId", "updatedAt")
          VALUES (gen_random_uuid()::text, ${org}, ${connectionId}, 'new', ${otherNew}, now())`,
      ).rejects.toThrow(/foreign key/i)
    })
  })
})
