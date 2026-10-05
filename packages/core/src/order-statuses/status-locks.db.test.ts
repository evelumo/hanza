import { randomUUID } from 'node:crypto'
import { createDb } from '@hanza/db'
import { describe, expect, it } from 'vitest'
import type { Actor } from '../actor'
import { createProduct } from '../catalog/products'
import { upsertOffers } from '../catalog/offers'
import { changeOrderStatus } from '../orders/change-status'
import { importOrder } from '../orders/import'
import { createTestOrganization, type TestContext } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, createTestConnection, orderLine } from '../testing/fixtures'
import { uniqueApplicationName, watchLockWaits } from '../testing/lock-waits'
import { TX_OPTIONS } from '../transaction'
import { deleteOrderStatus, finishOrderStatusDeletion } from './delete'
import { setStatusMapping } from './mapping'
import { createOrderStatus, listOrderStatuses, makeDefaultOrderStatus, moveOrderStatus, setOrderStatusActive, updateOrderStatus } from './statuses'

// Real parallel transactions. Only sessions tagged with this file's `application_name` are counted as waiting, so a
// zero proves that managing statuses never queued behind an Order write holding a reference to them (and vice versa).

const applicationName = uniqueApplicationName('hanza-status-locks')

async function addAdmin(ctx: TestContext, organizationId: string): Promise<Actor> {
  const userId = randomUUID()
  await ctx.db.user.create({ data: { id: userId, name: 'Admin', email: `${userId}@example.org` } })
  await ctx.db.member.create({ data: { id: randomUUID(), organizationId, userId, role: 'admin', createdAt: new Date() } })
  return { type: 'user', userId }
}

/** Fails instead of hanging when `promise` waits for a lock that is never released. */
async function within<T>(promise: Promise<T>, ms = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

describe.skipIf(!databaseUrl)('Order statuses under concurrency', () => {
  const context = useTestContext({ applicationName })

  async function setup() {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const admin = await addAdmin(ctx, org)
    const connectionId = await createTestConnection(ctx, org)
    const products: string[] = []
    for (const sku of ['A', 'B']) {
      products.push((await createProduct(ctx, org, { sku, name: sku, stock: 100 }, admin)).productId)
      await upsertOffers(ctx, org, connectionId, [{ externalId: `offer-${sku}`, sku, name: sku, url: null }], new Date())
    }
    const order = () => buildOrder({ lines: [orderLine('l1', { sku: 'B' }), orderLine('l2', { sku: 'A', quantity: 2 })] })
    const defaultOf = async (phase: string) => (await listOrderStatuses(ctx, org)).find((status) => status.phase === phase && status.isDefault)!.id
    return { ctx, org, admin, connectionId, order, defaultOf }
  }

  it('renaming, recolouring, reordering, deactivating and changing the default never wait for an Order write referencing the status', async () => {
    const { ctx, org, admin, connectionId, order, defaultOf } = await setup()
    const packing = (await createOrderStatus(ctx, org, { phase: 'processing', name: 'Packing', color: null }, admin)).statusId
    const processing = await defaultOf('processing')
    const first = await importOrder(ctx, org, connectionId, order())
    const second = await importOrder(ctx, org, connectionId, order())

    // Another session moves two Orders to these statuses and keeps its transaction open: it holds FOR KEY SHARE on both.
    const holder = createDb(databaseUrl!)
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let referenced!: () => void
    const isReferencing = new Promise<void>((resolve) => (referenced = resolve))
    const writer = holder.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "order" SET "phase" = 'processing', "statusId" = ${packing} WHERE "id" = ${first.orderId}`
      await tx.$executeRaw`UPDATE "order" SET "phase" = 'processing', "statusId" = ${processing} WHERE "id" = ${second.orderId}`
      referenced()
      await released
    }, { ...TX_OPTIONS, timeout: 30_000 })
    await isReferencing

    const watcher = watchLockWaits(databaseUrl!, applicationName)
    try {
      await within(updateOrderStatus(ctx, org, packing, { name: 'Waiting for packaging', color: 'amber' }, admin))
      await within(moveOrderStatus(ctx, org, packing, 'up', admin))
      await within(makeDefaultOrderStatus(ctx, org, packing, admin))
      await within(makeDefaultOrderStatus(ctx, org, processing, admin))
      await within(setOrderStatusActive(ctx, org, packing, false, admin))
      await within(setOrderStatusActive(ctx, org, packing, true, admin))
      expect(await watcher.stop()).toBe(0)
    } finally {
      release()
      await writer
      await holder.$disconnect()
    }
  })

  it('an Order import never waits for a status edit in progress', async () => {
    const { ctx, org, admin, connectionId, order } = await setup()
    const toCheck = (await createOrderStatus(ctx, org, { phase: 'new', name: 'To check', color: null }, admin)).statusId
    await setStatusMapping(ctx, org, connectionId, { new: toCheck }, admin)

    // Another session renames the mapped status and keeps its transaction open (FOR NO KEY UPDATE on the row).
    const holder = createDb(databaseUrl!)
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let editing!: () => void
    const isEditing = new Promise<void>((resolve) => (editing = resolve))
    const editor = holder.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "order_status" SET "name" = 'Renamed', "color" = 'red', "position" = 7 WHERE "id" = ${toCheck}`
      await tx.$executeRaw`UPDATE "order_status" SET "isDefault" = false WHERE "organizationId" = ${org} AND "phase" = 'new' AND "isDefault"`
      editing()
      await released
      throw new Error('rolled back: the organization keeps its default')
    }, { ...TX_OPTIONS, timeout: 30_000 })
    await isEditing

    const watcher = watchLockWaits(databaseUrl!, applicationName)
    try {
      const { orderId } = await within(importOrder(ctx, org, connectionId, order()))
      expect((await ctx.db.order.findFirstOrThrow({ where: { id: orderId } })).statusId).toBe(toCheck)
      expect(await watcher.stop()).toBe(0)
    } finally {
      release()
      await expect(editor).rejects.toThrow()
      await holder.$disconnect()
    }
  })

  it('imports, status changes, edits and deleting with a replacement run in parallel without deadlock or failure', async () => {
    const { ctx, org, admin, connectionId, order, defaultOf } = await setup()
    const incoming = (await createOrderStatus(ctx, org, { phase: 'new', name: 'Incoming', color: null }, admin)).statusId
    const toCheck = (await createOrderStatus(ctx, org, { phase: 'new', name: 'To check', color: null }, admin)).statusId
    const packing = (await createOrderStatus(ctx, org, { phase: 'processing', name: 'Packing', color: null }, admin)).statusId
    const packed = (await createOrderStatus(ctx, org, { phase: 'processing', name: 'Packed', color: null }, admin)).statusId
    await setStatusMapping(ctx, org, connectionId, { new: incoming }, admin)
    const existing: string[] = []
    for (let i = 0; i < 8; i++) {
      const { orderId } = await importOrder(ctx, org, connectionId, order())
      await changeOrderStatus(ctx, org, orderId, { statusId: packing }, admin)
      existing.push(orderId)
    }
    const newDefault = await defaultOf('new')

    const work: Array<Promise<unknown>> = [
      ...Array.from({ length: 16 }, () => importOrder(ctx, org, connectionId, order())),
      // The status the imports are mapped to is deleted while they run: they land on its replacement (or the default).
      // As the panel and then the worker would.
      deleteOrderStatus(ctx, org, incoming, toCheck, admin).then(() => finishOrderStatusDeletion(ctx, org, incoming, toCheck, admin, { batchSize: 3 })),
      deleteOrderStatus(ctx, org, packing, packed, admin).then(() => finishOrderStatusDeletion(ctx, org, packing, packed, admin, { batchSize: 3 })),
      ...existing.slice(0, 4).map((orderId) => changeOrderStatus(ctx, org, orderId, 'shipped', admin)),
      updateOrderStatus(ctx, org, toCheck, { name: 'Checking', color: 'blue' }, admin),
      moveOrderStatus(ctx, org, toCheck, 'up', admin),
      makeDefaultOrderStatus(ctx, org, toCheck, admin).then(() => makeDefaultOrderStatus(ctx, org, newDefault, admin)),
      updateOrderStatus(ctx, org, packed, { name: 'Boxed', color: null }, admin),
    ]
    const settled = await within(Promise.allSettled(work), 60_000)
    expect(settled.filter((result) => result.status === 'rejected')).toEqual([])

    const statuses = await listOrderStatuses(ctx, org)
    expect(statuses.map((status) => status.id)).not.toContain(incoming)
    expect(statuses.map((status) => status.id)).not.toContain(packing)
    const orders = await ctx.db.order.findMany({ where: { organizationId: org }, select: { phase: true, statusId: true } })
    expect(orders).toHaveLength(24)
    for (const stored of orders) {
      if (stored.phase === 'new') expect([toCheck, newDefault]).toContain(stored.statusId)
      if (stored.phase === 'processing') expect(stored.statusId).toBe(packed)
    }
  })
})
