import type { ChannelFact, Offer, OfferPrice, Order, OrderStatus, StockLevel } from '@hanza/connector-sdk'
import { createFakeConnector, type FakeConnector, type FakeState } from './connector'
import { seedFacts, seedOffers, seedOrders } from './seed'

export interface FakeChannel {
  connector: FakeConnector
  addOffer(offer: Offer): void
  /** Appends the Order to the journal. */
  addOrder(order: Order): void
  /**
   * Appends the fact to the Order and re-appends the Order to the journal; a `paid` fact also clears
   * `awaitingPayment`. Throws for an unknown Order.
   */
  addFact(orderExternalId: string, fact: ChannelFact): void
  /** Arguments of every stock.push call, in order. */
  readonly stockPushes: StockLevel[][]
  /** Arguments of every price.push call, in order. A push also sets the Offer's price that offers.pull reports. */
  readonly pricePushes: OfferPrice[][]
  readonly statusUpdates: Array<{ orderExternalId: string; status: OrderStatus }>
  /** The Channel refuses this Offer's stock and price with `code` from now on; null accepts them again. */
  reject(offerExternalId: string, code: string | null): void
  /** The Offer as offers.pull reports it now (its status changes when a push ends or reopens it). */
  offer(offerExternalId: string): Offer | undefined
  /** Back to the seed, recorded calls and rejections cleared. */
  reset(): void
}

/** `id` other than "fake" lets a test register several independent fake Channels side by side. */
export function createFakeChannel(options: { id?: string } = {}): FakeChannel {
  const state: FakeState = {
    offers: [],
    orders: new Map(),
    journal: [],
    stockPushes: [],
    pricePushes: [],
    statusUpdates: [],
    rejections: new Map(),
  }

  const appendToJournal = (orderExternalId: string) => {
    state.journal.push({ seq: state.journal.length + 1, orderExternalId })
  }

  const channel: FakeChannel = {
    connector: createFakeConnector(state, options.id),
    addOffer(offer) {
      const copy = structuredClone(offer)
      const index = state.offers.findIndex((existing) => existing.externalId === offer.externalId)
      if (index === -1) state.offers.push(copy)
      else state.offers[index] = copy
    },
    addOrder(order) {
      state.orders.set(order.externalId, structuredClone(order))
      appendToJournal(order.externalId)
    },
    addFact(orderExternalId, fact) {
      const order = state.orders.get(orderExternalId)
      if (!order) throw new Error(`Unknown Order "${orderExternalId}"`)
      order.facts.push(structuredClone(fact))
      // A real Channel reports a paid Order as no longer awaiting payment; the contract forbids both at once.
      if (fact.type === 'paid' && order.awaitingPayment === true) order.awaitingPayment = false
      // The contract wants facts oldest-first; Array.sort is stable, so equal times keep insertion order.
      order.facts.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
      appendToJournal(orderExternalId)
    },
    // The arrays are emptied in place on reset so references held by a test stay valid.
    stockPushes: state.stockPushes,
    pricePushes: state.pricePushes,
    statusUpdates: state.statusUpdates,
    reject(offerExternalId, code) {
      if (code === null) state.rejections.delete(offerExternalId)
      else state.rejections.set(offerExternalId, code)
    },
    offer(offerExternalId) {
      const offer = state.offers.find((candidate) => candidate.externalId === offerExternalId)
      return offer ? structuredClone(offer) : undefined
    },
    reset() {
      state.offers.length = 0
      state.orders.clear()
      state.journal.length = 0
      state.stockPushes.length = 0
      state.pricePushes.length = 0
      state.statusUpdates.length = 0
      state.rejections.clear()
      seedOffers.forEach(channel.addOffer)
      seedOrders.forEach(channel.addOrder)
      seedFacts.forEach(({ orderExternalId, fact }) => channel.addFact(orderExternalId, fact))
    },
  }
  channel.reset()
  return channel
}

/** Default instance, used by the connector registry. */
export const fakeChannel: FakeChannel = createFakeChannel()
export const fakeConnector = fakeChannel.connector
