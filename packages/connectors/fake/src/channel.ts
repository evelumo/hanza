import type { Address, ChannelFact, Offer, OfferPrice, Order, OrderPhase, OrderUpdate, RateLimits, StockLevel } from '@hanza/connector-sdk'
import { createFakeApi, type FakeApi } from './api'
import { createFakeConnector, withPublication, type FakeConnector, type FakeState } from './connector'
import { seedFacts, seedOffers, seedOrders } from './seed'

export interface FakeChannel {
  connector: FakeConnector
  /** Adds or replaces an Offer in the catalogue every account sees, publication included. */
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
  readonly statusUpdates: Array<{ orderExternalId: string; phase: OrderPhase }>
  /** The Channel refuses this Offer's stock and price with `code` from now on; null accepts them again. */
  reject(offerExternalId: string, code: string | null): void
  /**
   * The Offer as offers.pull reports it to the account with this API key (a push of that account may have ended or
   * reopened it); without one, as the catalogue has it.
   */
  offer(offerExternalId: string, apiKey?: string): Offer | undefined
  /** The Channel's HTTP side; the connector calls it only with `http: true`. */
  readonly api: FakeApi
  /** Back to the seed, recorded calls and rejections cleared. */
  reset(): void
}

export interface FakeChannelOptions {
  /** Other than "fake" lets a test register several independent fake Channels side by side. */
  id?: string
  /**
   * Every capability call also sends one request through `ctx.fetch`, answered by `api.fetch` (route the global
   * fetch there in tests), and maps a failed answer with `errorFromResponse`. Off by default: no network.
   */
  http?: boolean
  /** Declared on the connector, for tests of the core's limiter. */
  rateLimits?: RateLimits
  /**
   * Cursor null follows the SDK's starting rule (the Orders open now, then the journal, ADR 0021). Without it, cursor
   * null replays the whole journal, which the seed and most tests rely on.
   */
  startWithOpenOrders?: boolean
}

export function createFakeChannel(options: FakeChannelOptions = {}): FakeChannel {
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
    rejections: new Map(),
    publications: new Map(),
  }
  const api = createFakeApi()

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
    connector: createFakeConnector(state, options),
    api,
    addOffer(offer) {
      const copy = structuredClone(offer)
      const index = state.offers.findIndex((existing) => existing.externalId === offer.externalId)
      if (index === -1) state.offers.push(copy)
      else state.offers[index] = copy
      // A test that replaces an Offer sets how every account sees it.
      for (const own of state.publications.values()) own.delete(offer.externalId)
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
    reject(offerExternalId, code) {
      if (code === null) state.rejections.delete(offerExternalId)
      else state.rejections.set(offerExternalId, code)
    },
    offer(offerExternalId, apiKey) {
      const offer = state.offers.find((candidate) => candidate.externalId === offerExternalId)
      if (!offer) return undefined
      return structuredClone(apiKey === undefined ? offer : withPublication(state, apiKey, offer))
    },
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
      state.rejections.clear()
      state.publications.clear()
      api.reset()
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
