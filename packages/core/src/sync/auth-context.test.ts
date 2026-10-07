import { defineConnector } from '@hanza/connector-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createConnectorRegistry } from '../connectors/registry'
import type { Context } from '../context'
import { createInMemoryRateLimiter } from '../rate-limit'
import type { Bucket } from '../rate-limit/limiter'
import { buildAuthContext } from './auth-context'

const page = async () => ({ items: [], nextCursor: null, hasMore: false })
const limited = defineConnector({
  id: 'limited-oauth',
  name: 'Limited',
  kind: 'marketplace',
  configSchema: z.object({}),
  credentialsSchema: z.object({ token: z.string() }),
  auth: { type: 'oauth2' },
  rateLimits: { application: { requests: 100, windowMs: 60_000 }, connection: { concurrency: 2 } },
  capabilities: { 'offers.pull': page, 'orders.pull': page, 'stock.push': async () => {} },
})

function contextWithSpy() {
  const limiter = createInMemoryRateLimiter()
  const reserved: string[][] = []
  const reserve = limiter.reserve.bind(limiter)
  limiter.reserve = (buckets: Bucket[], maxWaitMs: number) => {
    reserved.push(buckets.map((bucket) => bucket.key))
    return reserve(buckets, maxWaitMs)
  }
  const log = { info() {}, warn() {}, error() {} }
  const ctx = { rateLimiter: limiter, log, connectors: createConnectorRegistry([limited]) } as unknown as Context
  return { ctx, reserved }
}

describe('buildAuthContext', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends sign-in hook requests through the connector’s request budgets (ADR 0019), like capabilities', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}'))
    const { ctx, reserved } = contextWithSpy()

    await buildAuthContext(ctx, limited, { app: {}, config: {}, connectionId: 'connection-1' }).fetch('https://api.example.test/token')
    // A new Connection's sign-in has no Connection yet: its own key, the application budget shared all the same.
    await buildAuthContext(ctx, limited, { app: {}, config: {}, signInId: 'sign-in-1' }).fetch('https://api.example.test/device')

    expect(reserved).toEqual([
      ['app:limited-oauth', 'conn:connection-1'],
      ['app:limited-oauth', 'conn:sign-in:sign-in-1'],
    ])
  })
})
