import { createDb } from '@hanza/db'
import { describe, expect, it } from 'vitest'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { createTestConnection, user } from '../testing/fixtures'
import { TX_OPTIONS } from '../transaction'
import { createConnection, getConnection, listConnections, listConnectionsForTick, openConnection } from './connections'
import { failSyncRun, finishSyncRun, saveSyncCursor, startSyncRun } from './sync-state'

describe.skipIf(!databaseUrl)('connections', () => {
  const context = useTestContext()

  it('stores credentials sealed and opens them only through openConnection', async () => {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const { connectionId } = await createConnection(
      ctx,
      org,
      { connectorId: 'fake', name: 'Mój kanał', config: { failMode: 'none' }, credentials: { apiKey: 'super-secret-key' } },
      user,
    )

    const raw = await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId } })
    expect(raw.credentials).toMatch(/^v1:/)
    expect(raw.credentials).not.toContain('super-secret-key')
    expect(await openConnection(ctx, org, connectionId)).toEqual({
      id: connectionId,
      organizationId: org,
      connectorId: 'fake',
      name: 'Mój kanał',
      config: { failMode: 'none' },
      credentials: { apiKey: 'super-secret-key' },
      health: 'unknown',
    })

    const listed = await listConnections(ctx, org)
    expect(listed).toHaveLength(1)
    expect(JSON.stringify(listed)).not.toContain('v1:')
    expect(listed[0]).not.toHaveProperty('credentials')
    const detail = await getConnection(ctx, org, connectionId)
    expect(detail).toMatchObject({ name: 'Mój kanał', config: { failMode: 'none' }, health: 'unknown', syncStates: [] })
    expect(detail).not.toHaveProperty('credentials')

    const created = await ctx.db.eventLog.findFirstOrThrow({ where: { organizationId: org, type: 'connection.created' } })
    expect(created.payload).toEqual({ connectorId: 'fake', actor: user })
  })

  it('a sealed value copied to another tenant does not open', async () => {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const other = await createTestOrganization(ctx.db)
    const mine = await createTestConnection(ctx, org)
    const theirs = await createTestConnection(ctx, other)
    const { credentials } = await ctx.db.connection.findFirstOrThrow({ where: { id: mine } })
    await ctx.db.connection.update({ where: { id: theirs }, data: { credentials } })
    await expect(openConnection(ctx, other, theirs)).rejects.toThrow()
  })

  it('records sync runs and health transitions with Events', async () => {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const connectionId = await createTestConnection(ctx, org)
    const health = async () => (await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId } })).health
    const healthEvents = () => ctx.db.eventLog.findMany({ where: { organizationId: org, type: 'connection.health_changed' }, orderBy: { id: 'asc' } })

    expect(await startSyncRun(ctx, org, connectionId, 'orders_pull')).toEqual({ cursor: null })
    await saveSyncCursor(ctx, org, connectionId, 'orders_pull', '5')
    await finishSyncRun(ctx, org, connectionId, 'orders_pull', { pulled: 5, imported: 4 })
    expect(await health()).toBe('ok')
    expect(await startSyncRun(ctx, org, connectionId, 'orders_pull')).toEqual({ cursor: '5' })

    await failSyncRun(ctx, org, connectionId, 'orders_pull', { kind: 'rate_limited', message: 'slow down', health: null })
    expect(await health()).toBe('ok')
    await failSyncRun(ctx, org, connectionId, 'stock_push', { kind: 'permanent', message: 'x'.repeat(1500), health: 'failing' })
    expect(await health()).toBe('failing')
    await failSyncRun(ctx, org, connectionId, 'offers_pull', { kind: 'auth_expired', message: '401 Unauthorized', health: 'auth_expired' })
    await failSyncRun(ctx, org, connectionId, 'offers_pull', { kind: 'auth_expired', message: '401 Unauthorized', health: 'auth_expired' })
    await finishSyncRun(ctx, org, connectionId, 'offers_pull', { seen: 1 })
    await finishSyncRun(ctx, org, connectionId, 'offers_pull', { seen: 1 })

    expect((await healthEvents()).map((event) => event.payload)).toEqual([
      { from: 'unknown', to: 'ok', errorKind: null },
      { from: 'ok', to: 'failing', errorKind: 'permanent' },
      { from: 'failing', to: 'auth_expired', errorKind: 'auth_expired' },
      { from: 'auth_expired', to: 'ok', errorKind: null },
    ])

    const detail = await getConnection(ctx, org, connectionId)
    const stream = (name: string) => detail?.syncStates.find((state) => state.stream === name)
    expect(stream('stock_push')).toMatchObject({ lastErrorKind: 'permanent', lastSucceededAt: null })
    expect(stream('stock_push')?.lastError).toHaveLength(1000)
    expect(stream('orders_pull')).toMatchObject({ lastResult: { pulled: 5, imported: 4 }, lastErrorKind: 'rate_limited', lastError: 'slow down' })
    expect(stream('offers_pull')).toMatchObject({ lastResult: { seen: 1 }, lastErrorKind: null, lastError: null })
    expect(stream('offers_pull')?.lastSucceededAt).toBeInstanceOf(Date)
  })

  it('changes health without waiting for an in-flight Offer insert on the Connection', async () => {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const connectionId = await createTestConnection(ctx, org)

    // The insert's foreign key holds a KEY SHARE lock on the Connection row until it commits.
    const holder = createDb(databaseUrl!)
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let inserted!: () => void
    const isInserted = new Promise<void>((resolve) => (inserted = resolve))
    const writer = holder.$transaction(async (tx) => {
      await tx.offer.create({ data: { organizationId: org, connectionId, externalId: 'in-flight', name: 'X', lastSeenAt: new Date() } })
      inserted()
      await released
    }, TX_OPTIONS)
    try {
      await isInserted
      const finished = finishSyncRun(ctx, org, connectionId, 'offers_pull', { seen: 0 }).then(() => 'finished')
      const blocked = new Promise((resolve) => setTimeout(() => resolve('blocked'), 2_000))
      expect(await Promise.race([finished, blocked])).toBe('finished')
      expect((await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId } })).health).toBe('ok')
    } finally {
      release()
      await writer
      await holder.$disconnect()
    }
  })

  it('never writes a sync_state row recorded under another organization', async () => {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const connectionId = await createTestConnection(ctx, org)
    const other = await createTestOrganization(ctx.db)
    // Inconsistent on purpose: this Connection's stream recorded under another organization.
    await ctx.db.syncState.create({ data: { organizationId: other, connectionId, stream: 'orders_pull', cursor: 'theirs' } })

    await expect(saveSyncCursor(ctx, org, connectionId, 'orders_pull', 'ours')).rejects.toMatchObject({ code: 'not_found' })
    await expect(startSyncRun(ctx, org, connectionId, 'orders_pull')).rejects.toMatchObject({ code: 'not_found' })

    expect(await ctx.db.syncState.findFirstOrThrow({ where: { connectionId, stream: 'orders_pull' } })).toMatchObject({
      organizationId: other,
      cursor: 'theirs',
    })
  })

  it('a later failure does not turn auth_expired into failing', async () => {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const connectionId = await createTestConnection(ctx, org)
    await failSyncRun(ctx, org, connectionId, 'offers_pull', { kind: 'auth_expired', message: '401 Unauthorized', health: 'auth_expired' })
    await failSyncRun(ctx, org, connectionId, 'stock_push', { kind: 'permanent', message: '400 Bad Request', health: 'failing' })
    await failSyncRun(ctx, org, connectionId, 'orders_pull', { kind: 'transient', message: '503', health: 'failing' })

    const connection = await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId } })
    expect(connection.health).toBe('auth_expired')
    const events = await ctx.db.eventLog.findMany({ where: { organizationId: org, type: 'connection.health_changed' } })
    expect(events.map((event) => event.payload)).toEqual([{ from: 'unknown', to: 'auth_expired', errorKind: 'auth_expired' }])
  })

  it('lists every tenant\'s Connections for the tick with their last start per stream', async () => {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const other = await createTestOrganization(ctx.db)
    const mine = await createTestConnection(ctx, org)
    const theirs = await createTestConnection(ctx, other)
    await startSyncRun(ctx, org, mine, 'offers_pull')

    const tick = await listConnectionsForTick(ctx)
    const row = tick.find((item) => item.id === mine)
    expect(row).toMatchObject({ organizationId: org, connectorId: 'fake', health: 'unknown' })
    expect(row?.lastStartedAt.offers_pull).toBeInstanceOf(Date)
    expect(row?.lastStartedAt.orders_pull).toBeUndefined()
    expect(tick.find((item) => item.id === theirs)).toMatchObject({ organizationId: other, lastStartedAt: {} })
    expect(JSON.stringify(tick)).not.toContain('v1:')
  })
})
