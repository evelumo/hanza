// Test and recording tooling only: never imported by the connector itself.
import { isOrderUpdate, orderSchema, orderUpdateSchema, type OrderFeedItem } from '@hanza/connector-sdk'
import { isRecording } from '@hanza/connector-sdk/testing'
import { expect } from 'vitest'
import { changesStart, encodeCursor, parseCursor } from '../capabilities/orders-cursor'
import { createWooCommerceConnector, type WooCommerceConnectorOptions } from '../connector'
import type { OrdersScenario, ScenarioKey } from './orders-scenario'

// What the recorded scenarios of the Order feed share: a feed polled as the engine polls it, and orders to place.

export const label = (item: OrderFeedItem) => (isOrderUpdate(item) ? `update ${item.externalId}` : `order ${item.externalId}`)
export const labels = (items: OrderFeedItem[]) => items.map(label)
export const factTypes = (item: OrderFeedItem | undefined) => item?.facts.map((fact) => fact.type)

/** A Connection's feed on the scenario's shop. Every item is checked against its canonical schema as it arrives. */
export function feedOf(scenario: OrdersScenario, options: WooCommerceConnectorOptions, key: ScenarioKey = 'readWrite') {
  const pullOrders = createWooCommerceConnector(options).capabilities['orders.pull']!
  const feed = {
    cursor: null as string | null,
    async page() {
      const result = await pullOrders(scenario.context(key), feed.cursor)
      for (const item of result.items) expect((isOrderUpdate(item) ? orderUpdateSchema : orderSchema).safeParse(item).success, label(item)).toBe(true)
      if (result.hasMore) expect(result.nextCursor).not.toBe(feed.cursor)
      feed.cursor = result.nextCursor
      return result
    },
    /** Every page until the feed has no more. */
    async poll() {
      const items: OrderFeedItem[] = []
      for (let pages = 0; pages < 50; pages++) {
        const result = await feed.page()
        items.push(...result.items)
        if (!result.hasMore) return items
      }
      throw new Error('the feed never ended')
    },
    /** The start and the whole listing, page by page, stopping before the first read of the changes. */
    async list() {
      const pages: OrderFeedItem[][] = []
      while (feed.cursor === null || feed.cursor.startsWith('l1:')) pages.push((await feed.page()).items)
      // The first call only takes the start.
      return pages.slice(1)
    },
    /** Takes the start, then goes straight to the changes: what a feed is after its listing, without listing. */
    async startAtChanges() {
      await feed.page()
      const start = parseCursor(feed.cursor!)
      feed.cursor = encodeCursor(changesStart(start.start, start.boundary))
      return start
    },
  }
  return feed
}

// Invented, like everybody in the seed.
const buyer = {
  first_name: 'Nina',
  last_name: 'Zmyślona',
  address_1: 'ul. Nieistniejąca 7',
  city: 'Gdańsk',
  postcode: '80-001',
  country: 'PL',
  email: 'nina.zmyslona@example.test',
  phone: '+48 000 000 201',
}

/** The body of `POST orders` for an order of two mugs, paid online unless the overrides say otherwise. */
export const newOrder = (overrides: Record<string, unknown> = {}) => ({
  payment_method: 'przelewy24',
  payment_method_title: 'Przelewy24',
  billing: buyer,
  shipping: buyer,
  line_items: [{ product_id: 10, quantity: 2 }],
  ...overrides,
})

/**
 * The id the shop gave an order a scenario placed. A recording must get the id its expectations name on replay
 * (`expected`), which a fresh shop of the pinned version gives; elsewhere (a check against a live shop of another
 * version, where other things take ids in between) the scenario goes on with the id it got.
 */
export function expectId(created: number, expected: number): number {
  if (isRecording() && created !== expected) {
    throw new Error(`The sandbox gave the new order id ${created}, not ${expected}: record from a fresh shop (sandbox.sh reset)`)
  }
  return created
}
