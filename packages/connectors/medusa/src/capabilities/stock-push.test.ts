import { PermanentError, TransientError } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { LOCATION_NOT_SET_MESSAGE, PLUGIN_MISSING_MESSAGE } from '../client'
import { medusaConnector } from '../connector'
import { FakeMedusa } from '../testing/fake-medusa'
import { NOT_CONFIRMED_MESSAGE, UNKNOWN_REJECTION } from './stock-push'

const push = (store: FakeMedusa, levels: Array<{ offerExternalId: string; available: number }>) =>
  medusaConnector.capabilities['stock.push']!(
    store.context(),
    levels.map((level) => ({ ...level, sku: null })),
  )

function store(): FakeMedusa {
  return new FakeMedusa()
    .variant('variant_001')
    .variant('variant_002', { manage_inventory: false })
    .variant('variant_003', { kit: true })
}

describe('stock.push', () => {
  it('sends one request with the availability of each variant, and maps the plugin\'s results one to one', async () => {
    const medusa = store()
    const results = await push(medusa, [
      { offerExternalId: 'variant_001', available: 0 },
      { offerExternalId: 'variant_002', available: 3 },
      { offerExternalId: 'variant_003', available: 3 },
      { offerExternalId: 'variant_gone', available: 3 },
    ])
    expect(medusa.writes).toEqual([
      {
        path: 'hanza/stock',
        body: {
          levels: [
            { variant_id: 'variant_001', available: 0 },
            { variant_id: 'variant_002', available: 3 },
            { variant_id: 'variant_003', available: 3 },
            { variant_id: 'variant_gone', available: 3 },
          ],
        },
      },
    ])
    // Never `ended`, also for 0: Medusa keeps the variant published.
    expect(results).toEqual([
      { offerExternalId: 'variant_001', outcome: 'ok' },
      { offerExternalId: 'variant_002', outcome: 'rejected', code: 'inventory_not_managed' },
      { offerExternalId: 'variant_003', outcome: 'rejected', code: 'inventory_kit' },
      { offerExternalId: 'variant_gone', outcome: 'rejected', code: 'unknown_variant' },
    ])
    expect(medusa.stock.get('variant_001')).toBe(0)
  })

  it('makes no request for no levels, and sends a level given twice once, with its last number', async () => {
    const medusa = store()
    expect(await push(medusa, [])).toEqual([])
    expect(medusa.requests).toEqual([])
    await push(medusa, [
      { offerExternalId: 'variant_001', available: 1 },
      { offerExternalId: 'variant_001', available: 4 },
    ])
    expect(medusa.writes[0]!.body).toEqual({ levels: [{ variant_id: 'variant_001', available: 4 }] })
  })

  it('is repeatable', async () => {
    const medusa = store()
    const levels = [{ offerExternalId: 'variant_001', available: 5 }]
    expect(await push(medusa, levels)).toEqual(await push(medusa, levels))
    expect(medusa.stock.get('variant_001')).toBe(5)
  })

  it('fails the whole call telling the person to pick a stock location while none is chosen', async () => {
    const medusa = store()
    medusa.settings.stock_location_id = null
    await expect(push(medusa, [{ offerExternalId: 'variant_001', available: 1 }])).rejects.toThrow(LOCATION_NOT_SET_MESSAGE)
  })

  it('says the plugin is missing', async () => {
    const medusa = store()
    medusa.pluginInstalled = false
    await expect(push(medusa, [{ offerExternalId: 'variant_001', available: 1 }])).rejects.toThrow(PLUGIN_MISSING_MESSAGE)
  })

  it('fails as transient when the answer leaves a variant out, and passes on only short machine codes', async () => {
    const answering = (results: unknown[]) => ({
      ...store().context(),
      fetch: (async () => new Response(JSON.stringify({ format: 1, plugin: { name: 'medusa-plugin-hanza', version: '0.1.0' }, results }), { headers: { 'content-type': 'application/json' } })) as typeof fetch,
    })
    const pushWith = (results: unknown[]) =>
      medusaConnector.capabilities['stock.push']!(answering(results), [
        { offerExternalId: 'variant_001', sku: null, available: 1 },
        { offerExternalId: 'variant_002', sku: null, available: 1 },
      ])
    await expect(pushWith([{ variant_id: 'variant_001', outcome: 'ok' }])).rejects.toThrow(NOT_CONFIRMED_MESSAGE)
    await expect(pushWith([{ variant_id: 'variant_001', outcome: 'ok' }])).rejects.toBeInstanceOf(TransientError)
    expect(
      await pushWith([
        { variant_id: 'variant_001', outcome: 'rejected', code: 'Anna Nowak has no stock' },
        { variant_id: 'variant_002', outcome: 'rejected' },
        { variant_id: 'variant_other', outcome: 'ok' },
      ]),
    ).toEqual([
      { offerExternalId: 'variant_001', outcome: 'rejected', code: UNKNOWN_REJECTION },
      { offerExternalId: 'variant_002', outcome: 'rejected', code: UNKNOWN_REJECTION },
    ])
  })

  it('refuses an answer in another wire format', async () => {
    const medusa = store()
    medusa.format = 3
    await expect(push(medusa, [{ offerExternalId: 'variant_001', available: 1 }])).rejects.toBeInstanceOf(PermanentError)
  })
})
