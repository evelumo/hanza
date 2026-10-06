import type { Address, ChannelFact, Offer, OfferPrice, Order, OrderStatus, OrderUpdate, StockLevel } from '@hanza/connector-sdk'
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
  /**
   * Changes the Order on the Channel and appends exactly this change to the journal as an Order update (not the whole
   * Order): new facts (a `paid` one also clears `awaitingPayment`) and addresses. Throws for an unknown Order.
   */
  updateOrder(orderExternalId: string, change: { facts?: ChannelFact[]; shippingAddress?: Address; billingAddress?: Address | null }): void
  /**
   * Deletes the Order on the Channel, as when a purchase is merged into another one, and appends an Order update with
   * `fact` (a `cancelled` one). Every journal entry of the Order is pulled as that update from then on.
   */
  removeOrder(orderExternalId: string, fact: ChannelFact): void
  /** Drops every journal entry so far, as a Channel that keeps its journal for a limited time: older cursors expire. */
  forgetJournal(): void
  /** Arguments of every stock.push call, in order. */
  readonly stockPushes: StockLevel[][]
  /** Arguments of every price.push call, in order. A push also sets the Offer's price that offers.pull reports. */
  readonly pricePushes: OfferPrice[][]
  readonly statusUpdates: Array<{ orderExternalId: string; status: OrderStatus }>
  /** Back to the seed, recorded calls cleared. */
  reset(): void
}

/**
 * `id` other than "fake" lets a test register several independent fake Channels side by side. `startWithOpenOrders`
 * makes cursor null follow the SDK's starting rule (the Orders open now, then the journal); without it, cursor null
 * replays the whole journal, which the seed and most tests rely on.
 */
export function createFakeChannel(options: { id?: string; startWithOpenOrders?: boolean } = {}): FakeChannel {
  const state: FakeState = {
    offers: [],
    orders: new Map(),
    removed: new Map(),
    firstSeq: new Map(),
    journal: [],
    lastSeq: 0,
    forgottenThrough: 0,
    startWithOpenOrders: options.startWithOpenOrders === true,
    stockPushes: [],
    pricePushes: [],
    statusUpdates: [],
  }

  const appendToJournal = (orderExternalId: string, update?: OrderUpdate) => {
    const seq = ++state.lastSeq
    if (!state.firstSeq.has(orderExternalId)) state.firstSeq.set(orderExternalId, seq)
    state.journal.push(update ? { seq, orderExternalId, update: structuredClone(update) } : { seq, orderExternalId })
  }

  const orderOf = (orderExternalId: string): Order => {
    const order = state.orders.get(orderExternalId)
    if (!order) throw new Error(`Unknown Order "${orderExternalId}"`)
    return order
  }

  const recordFact = (order: Order, fact: ChannelFact) => {
    order.facts.push(structuredClone(fact))
    // A real Channel reports a paid Order as no longer awaiting payment; the contract forbids both at once.
    if (fact.type === 'paid' && order.awaitingPayment === true) order.awaitingPayment = false
    // The contract wants facts oldest-first; Array.sort is stable, so equal times keep insertion order.
    order.facts.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
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
      recordFact(orderOf(orderExternalId), fact)
      appendToJournal(orderExternalId)
    },
    updateOrder(orderExternalId, change) {
      const order = orderOf(orderExternalId)
      const facts = change.facts ?? []
      facts.forEach((fact) => recordFact(order, fact))
      if (change.shippingAddress !== undefined) order.shippingAddress = structuredClone(change.shippingAddress)
      if (change.billingAddress !== undefined) order.billingAddress = structuredClone(change.billingAddress)
      appendToJournal(orderExternalId, { kind: 'update', externalId: orderExternalId, ...structuredClone({ ...change, facts }) })
    },
    removeOrder(orderExternalId, fact) {
      orderOf(orderExternalId)
      const update: OrderUpdate = { kind: 'update', externalId: orderExternalId, facts: [structuredClone(fact)] }
      state.orders.delete(orderExternalId)
      state.removed.set(orderExternalId, update)
      appendToJournal(orderExternalId, update)
    },
    forgetJournal() {
      state.forgottenThrough = state.lastSeq
      state.journal.length = 0
    },
    // The arrays are emptied in place on reset so references held by a test stay valid.
    stockPushes: state.stockPushes,
    pricePushes: state.pricePushes,
    statusUpdates: state.statusUpdates,
    reset() {
      state.offers.length = 0
      state.orders.clear()
      state.removed.clear()
      state.firstSeq.clear()
      state.journal.length = 0
      state.lastSeq = 0
      state.forgottenThrough = 0
      state.stockPushes.length = 0
      state.pricePushes.length = 0
      state.statusUpdates.length = 0
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
