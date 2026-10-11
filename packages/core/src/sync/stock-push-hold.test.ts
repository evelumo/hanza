import { defineConnector } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { isStockPushHeldBy } from './stock-push-hold'

const empty = async () => ({ items: [], nextCursor: null, hasMore: false })
const base = { auth: { type: 'none' }, configSchema: z.object({}), credentialsSchema: z.object({}) } as const
const channel = defineConnector({
  ...base,
  id: 'hold-unit-channel',
  name: 'Channel',
  kind: 'marketplace',
  capabilities: { 'offers.pull': empty, 'orders.pull': empty, async 'stock.push'() {} },
})
// Not a Channel, so not bound to implement `orders.pull`; a stock push of its own has no Order feed to wait for.
const warehouse = defineConnector({ ...base, id: 'hold-unit-wms', name: 'WMS', kind: 'courier', capabilities: { async 'stock.push'() {} } })

describe('isStockPushHeldBy', () => {
  it('holds a Channel until its Order feed caught up', () => {
    expect(isStockPushHeldBy(channel, undefined)).toBe(true)
    expect(isStockPushHeldBy(channel, { caughtUpAt: null })).toBe(true)
    expect(isStockPushHeldBy(channel, { caughtUpAt: new Date() })).toBe(false)
  })

  it('never holds a connector without an Order feed, or one that is not registered', () => {
    expect(isStockPushHeldBy(warehouse, undefined)).toBe(false)
    expect(isStockPushHeldBy(undefined, undefined)).toBe(false)
  })
})
