import { defineConnector } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { openConnection } from '../connections/connections'
import { DomainError } from '../errors'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { user } from '../testing/fixtures'
import { addConnection, requestSync } from './requests'

const shop = defineConnector({
  id: 'requests-shop',
  name: 'Shop',
  kind: 'shop',
  auth: { type: 'apiKey' },
  configSchema: z.object({ shopUrl: z.url(), pageSize: z.number().int().default(50) }),
  credentialsSchema: z.object({ apiKey: z.string().min(1) }),
  capabilities: {
    async 'offers.pull'() {
      return { items: [], nextCursor: null, hasMore: false }
    },
    async 'orders.pull'() {
      return { items: [], nextCursor: null, hasMore: false }
    },
    async 'stock.push'() {},
  },
})

async function domainError(promise: Promise<unknown>): Promise<DomainError> {
  const error = await promise.catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(DomainError)
  return error as DomainError
}

describe.skipIf(!databaseUrl)('addConnection and requestSync', () => {
  const context = useTestContext({ connectors: [shop] })

  it('rejects invalid settings with issue paths prefixed config. and credentials.', async () => {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const error = await domainError(
      addConnection(ctx, org, { connectorId: 'requests-shop', name: 'Sklep', config: { shopUrl: 'not a url' }, credentials: {} }, user),
    )
    expect(error.code).toBe('invalid_config')
    const issues = error.details?.issues as Array<{ path: string; message: string }>
    expect(issues.map((issue) => issue.path)).toEqual(['config.shopUrl', 'credentials.apiKey'])
    expect(issues.every((issue) => issue.message.length > 0)).toBe(true)
    expect(await ctx.db.connection.count({ where: { organizationId: org } })).toBe(0)
  })

  it('rejects an unknown connector', async () => {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const error = await domainError(addConnection(ctx, org, { connectorId: 'nope', name: 'X', config: {}, credentials: {} }, user))
    expect(error.code).toBe('unknown_connector')
  })

  it('stores the parsed settings and starts a manual Offer pull', async () => {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const { connectionId } = await addConnection(
      ctx,
      org,
      { connectorId: 'requests-shop', name: 'Sklep', config: { shopUrl: 'https://shop.example.com', extra: 1 }, credentials: { apiKey: 'k' } },
      user,
    )
    expect(await openConnection(ctx, org, connectionId)).toMatchObject({
      config: { shopUrl: 'https://shop.example.com', pageSize: 50 },
      credentials: { apiKey: 'k' },
    })
    expect(ctx.queue.enqueued.filter((job) => (job.payload as { connectionId: string }).connectionId === connectionId)).toEqual([
      {
        name: 'offers.pull',
        payload: { organizationId: org, connectionId, trigger: 'manual' },
        options: { coalesceKey: `offers.pull:${connectionId}` },
      },
    ])
  })

  it('a failed enqueue after the Connection is stored is logged, not thrown', async () => {
    const base = context()
    const errors: Array<[string, Record<string, unknown> | undefined]> = []
    const ctx = {
      ...base,
      log: { info() {}, error: (message: string, fields?: Record<string, unknown>) => void errors.push([message, fields]) },
      queue: {
        ...base.queue,
        enqueue: async () => {
          throw new Error('Redis is down')
        },
      },
    }
    const org = await createTestOrganization(ctx.db)
    const { connectionId } = await addConnection(
      ctx,
      org,
      { connectorId: 'requests-shop', name: 'Sklep', config: { shopUrl: 'https://shop.example.com' }, credentials: { apiKey: 'k' } },
      user,
    )
    expect(await ctx.db.connection.count({ where: { id: connectionId, organizationId: org } })).toBe(1)
    expect(errors).toEqual([
      ['post-commit step failed', { job: 'offers.pull', organizationId: org, connectionId, error: 'Redis is down' }],
    ])
  })

  it('requestSync enqueues an Offer pull and a stock push, only for the organization\'s own Connection', async () => {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const other = await createTestOrganization(ctx.db)
    const { connectionId } = await addConnection(
      ctx,
      org,
      { connectorId: 'requests-shop', name: 'Sklep', config: { shopUrl: 'https://shop.example.com' }, credentials: { apiKey: 'k' } },
      user,
    )
    expect((await domainError(requestSync(ctx, other, connectionId))).code).toBe('not_found')

    ctx.queue.waiting.length = 0
    await requestSync(ctx, org, connectionId)
    expect(ctx.queue.waiting.map((job) => [job.name, job.payload])).toEqual([
      ['offers.pull', { organizationId: org, connectionId, trigger: 'manual' }],
      ['stock.push', { organizationId: org, connectionId }],
    ])
  })
})
