import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineConnector, isChannel, listCapabilities, type AnyConnectorDefinition } from './connector'

const base = {
  name: 'Example',
  auth: { type: 'apiKey' as const },
  configSchema: z.object({ baseUrl: z.url() }),
  credentialsSchema: z.object({ token: z.string() }),
}

const page = async () => ({ items: [], nextCursor: null, hasMore: false })
const channelCapabilities = { 'offers.pull': page, 'orders.pull': page, 'stock.push': async () => {} }

describe('defineConnector', () => {
  it('lists only the capabilities a connector implements', () => {
    const connector = defineConnector({
      ...base,
      id: 'example-courier',
      kind: 'courier',
      capabilities: { 'orders.updateStatus': async () => {} },
    })
    expect(listCapabilities(connector)).toEqual(['orders.updateStatus'])
  })

  it('rejects ids that are not lowercase slugs', () => {
    expect(() => defineConnector({ ...base, id: 'Example Shop', kind: 'courier', capabilities: {} })).toThrow(
      /Invalid connector id/,
    )
  })

  it.each(['offers.pull', 'orders.pull', 'stock.push'] as const)('rejects a Channel without %s', (missing) => {
    const { [missing]: _removed, ...capabilities } = channelCapabilities
    expect(() => defineConnector({ ...base, id: 'example-shop', kind: 'shop', capabilities })).toThrow(
      new RegExp(`must implement ${missing}`),
    )
    expect(() => defineConnector({ ...base, id: 'example-market', kind: 'marketplace', capabilities })).toThrow(
      new RegExp(missing),
    )
  })

  it('accepts a Channel with the required capabilities and a courier with none', () => {
    expect(() => defineConnector({ ...base, id: 'example-shop', kind: 'shop', capabilities: channelCapabilities })).not.toThrow()
    expect(() => defineConnector({ ...base, id: 'example-courier', kind: 'courier', capabilities: {} })).not.toThrow()
  })

  it('keeps definitions with specific config types assignable to AnyConnectorDefinition', () => {
    const connector: AnyConnectorDefinition = defineConnector({
      ...base,
      id: 'example-shop',
      kind: 'shop',
      capabilities: { ...channelCapabilities, 'stock.push': async (ctx) => void ctx.config.baseUrl.length },
    })
    expect(connector.id).toBe('example-shop')
  })
})

describe('isChannel', () => {
  it.each([
    ['marketplace', true],
    ['shop', true],
    ['courier', false],
    ['invoicing', false],
  ] as const)('%s -> %s', (kind, expected) => {
    expect(isChannel({ ...base, id: 'x', kind, capabilities: {} })).toBe(expected)
  })
})
