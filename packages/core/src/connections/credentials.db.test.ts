import { AuthExpiredError, defineConnector, type AuthContext } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PermanentJobError, type JobRunInfo } from '../jobs'
import { ordersPullJob } from '../jobs/orders-pull'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { user } from '../testing/fixtures'
import { createConnection, openConnection } from './connections'
import { refreshCredentials } from './credentials'

type Credentials = { accessToken: string; refreshToken: string; expiresAt: string }

const credentialsSchema = z.object({ accessToken: z.string().min(1), refreshToken: z.string().min(1), expiresAt: z.iso.datetime() })
let refreshImpl: (ctx: AuthContext, credentials: Credentials) => Promise<Credentials> = async () => {
  throw new Error('no refresh in this test')
}
const accepted = new Set<string>()
const pulledWith: string[] = []

const oauthChannel = defineConnector({
  id: 'oauth-test',
  name: 'OAuth test',
  kind: 'marketplace',
  appConfigSchema: z.object({ clientId: z.string().min(1) }),
  configSchema: z.object({}),
  credentialsSchema,
  auth: {
    type: 'oauth2',
    expiresAt: (credentials) => credentials.expiresAt,
    refresh: (ctx, credentials) => refreshImpl(ctx, credentials),
  },
  capabilities: {
    async 'offers.pull'() {
      return { items: [], nextCursor: null, hasMore: false }
    },
    async 'orders.pull'(ctx, cursor) {
      pulledWith.push(ctx.credentials.accessToken)
      if (!accepted.has(ctx.credentials.accessToken)) throw new AuthExpiredError('401 Unauthorized')
      return { items: [], nextCursor: cursor, hasMore: false }
    },
    async 'stock.push'() {},
  },
})
// Same connector under another id, for a Hanza where its installation settings are missing.
const unconfigured = { ...oauthChannel, id: 'oauth-unconfigured', name: 'Unconfigured' }

const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()
const run: JobRunInfo = { attempt: 1, maxAttempts: 5, retriedLater: 0 }

describe.skipIf(!databaseUrl)('credentials refresh (ADR 0019)', () => {
  const context = useTestContext({
    connectors: [oauthChannel, unconfigured],
    connectorSettings: { HANZA_CONNECTOR_OAUTH_TEST_CLIENT_ID: 'client-1' },
  })

  async function setup(credentials: Credentials) {
    const ctx = context()
    const organizationId = await createTestOrganization(ctx.db)
    const { connectionId } = await createConnection(
      ctx,
      organizationId,
      { connectorId: 'oauth-test', name: 'OAuth', config: {}, credentials },
      user,
    )
    return { ctx, organizationId, connectionId }
  }

  let counter = 0
  function rotating(options: { delayMs?: number } = {}) {
    const calls: Array<{ refreshToken: string; clientId: unknown }> = []
    refreshImpl = async (ctx, credentials) => {
      calls.push({ refreshToken: credentials.refreshToken, clientId: (ctx.app as { clientId: string }).clientId })
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      counter++
      const accessToken = `access-${counter}`
      accepted.add(accessToken)
      return { accessToken, refreshToken: `refresh-${counter}`, expiresAt: inMinutes(60) }
    }
    return calls
  }

  it('lets one of two concurrent refreshes through; the other re-reads the rotated credentials', async () => {
    const { ctx, organizationId, connectionId } = await setup({ accessToken: 'old', refreshToken: 'r0', expiresAt: inMinutes(5) })
    const calls = rotating({ delayMs: 300 })
    const input = { organizationId, connectionId, connector: oauthChannel, app: { clientId: 'client-1' }, seenVersion: 0, force: false }
    const [first, second] = await Promise.all([refreshCredentials(ctx, input), refreshCredentials(ctx, input)])

    expect(calls).toEqual([{ refreshToken: 'r0', clientId: 'client-1' }])
    expect([first!.refreshed, second!.refreshed].sort()).toEqual([false, true])
    expect(first!.credentials).toEqual(second!.credentials)
    expect(first!.version).toBe(1)
    expect(second!.version).toBe(1)

    const stored = await openConnection(ctx, organizationId, connectionId)
    expect(stored).toMatchObject({ credentials: first!.credentials, credentialsVersion: 1 })
    const raw = await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId, organizationId } })
    expect(raw.credentials).not.toContain((first!.credentials as Credentials).accessToken)
    expect(raw.credentialsExpireAt?.toISOString()).toBe((first!.credentials as Credentials).expiresAt)
  })

  it('does not refresh fresh credentials unless forced, nor credentials another job already replaced', async () => {
    const { ctx, organizationId, connectionId } = await setup({ accessToken: 'fresh', refreshToken: 'r', expiresAt: inMinutes(120) })
    const calls = rotating()
    const input = { organizationId, connectionId, connector: oauthChannel, app: { clientId: 'client-1' }, force: false }
    expect(await refreshCredentials(ctx, { ...input, seenVersion: 0 })).toMatchObject({ refreshed: false, version: 0 })
    expect(calls).toHaveLength(0)
    expect(await refreshCredentials(ctx, { ...input, seenVersion: 0, force: true })).toMatchObject({ refreshed: true, version: 1 })
    // A job that read version 0 and got a 401 just re-reads version 1.
    expect(await refreshCredentials(ctx, { ...input, seenVersion: 0, force: true })).toMatchObject({ refreshed: false, version: 1 })
    expect(calls).toHaveLength(1)
  })

  it('writes nothing when the refresh is refused', async () => {
    const { ctx, organizationId, connectionId } = await setup({ accessToken: 'old', refreshToken: 'dead', expiresAt: inMinutes(1) })
    refreshImpl = async () => {
      throw new AuthExpiredError('400 invalid_grant')
    }
    await expect(
      refreshCredentials(ctx, { organizationId, connectionId, connector: oauthChannel, app: {}, seenVersion: 0, force: false }),
    ).rejects.toBeInstanceOf(AuthExpiredError)
    expect(await openConnection(ctx, organizationId, connectionId)).toMatchObject({ credentialsVersion: 0, credentials: { accessToken: 'old' } })
  })

  it('refreshes before a run when the token is about to expire, and once after a 401, retrying the call', async () => {
    const { ctx, organizationId, connectionId } = await setup({ accessToken: 'stale', refreshToken: 'r', expiresAt: inMinutes(10) })
    const calls = rotating()
    pulledWith.length = 0
    await ordersPullJob.handler(ctx, { organizationId, connectionId, trigger: 'manual' }, run)
    expect(calls).toHaveLength(1)
    const firstToken = (await openConnection(ctx, organizationId, connectionId))!.credentials as Credentials
    // The stale token was never sent: the refresh happened before the first call.
    expect(pulledWith).toEqual([firstToken.accessToken])

    // The Channel drops the token early; the run refreshes once and retries the same call.
    accepted.delete(firstToken.accessToken)
    pulledWith.length = 0
    await ordersPullJob.handler(ctx, { organizationId, connectionId, trigger: 'manual' }, run)
    const secondToken = (await openConnection(ctx, organizationId, connectionId))!.credentials as Credentials
    expect(calls).toHaveLength(2)
    expect(pulledWith).toEqual([firstToken.accessToken, secondToken.accessToken])
    const connection = await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId, organizationId } })
    expect(connection).toMatchObject({ health: 'ok', credentialsVersion: 2 })
  })

  it('marks the Connection auth_expired, without a retry, when the refresh after a 401 is refused', async () => {
    const { ctx, organizationId, connectionId } = await setup({ accessToken: 'revoked', refreshToken: 'dead', expiresAt: inMinutes(60) })
    let refreshes = 0
    refreshImpl = async () => {
      refreshes++
      throw new AuthExpiredError('400 invalid_grant')
    }
    await expect(ordersPullJob.handler(ctx, { organizationId, connectionId, trigger: 'manual' }, run)).rejects.toBeInstanceOf(PermanentJobError)
    expect(refreshes).toBe(1)
    const connection = await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId, organizationId } })
    expect(connection.health).toBe('auth_expired')
    const state = await ctx.db.syncState.findFirstOrThrow({ where: { organizationId, connectionId, stream: 'orders_pull' } })
    expect(state).toMatchObject({ lastErrorKind: 'auth_expired', lastError: '400 invalid_grant' })
  })

  it('fails a run permanently, naming the variables, when the connector is not set up on this installation', async () => {
    const ctx = context()
    const organizationId = await createTestOrganization(ctx.db)
    const { connectionId } = await createConnection(
      ctx,
      organizationId,
      { connectorId: 'oauth-unconfigured', name: 'X', config: {}, credentials: { accessToken: 'a', refreshToken: 'r', expiresAt: inMinutes(60) } },
      user,
    )
    await expect(ordersPullJob.handler(ctx, { organizationId, connectionId, trigger: 'manual' }, run)).rejects.toBeInstanceOf(PermanentJobError)
    const state = await ctx.db.syncState.findFirstOrThrow({ where: { organizationId, connectionId, stream: 'orders_pull' } })
    expect(state).toMatchObject({
      lastErrorKind: 'permanent',
      lastError: 'Unconfigured is not set up on this installation: HANZA_CONNECTOR_OAUTH_UNCONFIGURED_CLIENT_ID',
    })
    expect((await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId } })).health).toBe('failing')
  })
})
