import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineConnector, listCapabilities } from './connector'

const base = {
  name: 'Example',
  kind: 'shop' as const,
  auth: { type: 'apiKey' as const },
  configSchema: z.object({ baseUrl: z.url() }),
}

describe('defineConnector', () => {
  it('lists only the capabilities a connector implements', () => {
    const connector = defineConnector({
      ...base,
      id: 'example-shop',
      capabilities: {
        'orders.pull': async () => ({ items: [], nextCursor: null }),
      },
    })
    expect(listCapabilities(connector)).toEqual(['orders.pull'])
  })

  it('rejects ids that are not lowercase slugs', () => {
    expect(() => defineConnector({ ...base, id: 'Example Shop', capabilities: {} })).toThrow(/Invalid connector id/)
  })
})
