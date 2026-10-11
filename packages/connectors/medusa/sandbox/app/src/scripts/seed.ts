import type { CreateInventoryLevelInput, ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules, ProductStatus } from "@medusajs/framework/utils"
import {
  createApiKeysWorkflow,
  createInventoryLevelsWorkflow,
  createProductsWorkflow,
  createRegionsWorkflow,
  createSalesChannelsWorkflow,
  createShippingOptionsWorkflow,
  createShippingProfilesWorkflow,
  createStockLocationsWorkflow,
  createTaxRegionsWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
  updateStoresWorkflow,
} from "@medusajs/medusa/core-flows"

// The sandbox's seed, run in the medusa container while the server is up (`sandbox.sh seed`):
//
//   npx medusa exec ./src/scripts/seed.ts
//
// The catalogue goes in through Medusa's workflows; the orders go through the Store API, as a Buyer's would, and the
// payments, fulfillments and cancels through the Admin API, so the plugin's subscribers see the events a real store
// emits. Everything is invented. Once per store: a second run is refused ("reset" gives a fresh one).

const SERVER = "http://127.0.0.1:9000"
const REGION_NAME = "Poland"

type Json = Record<string, any>

async function http(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Json> {
  const response = await fetch(`${SERVER}${path}`, {
    method,
    headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${text.slice(0, 500)}`)
  return text === "" ? {} : (JSON.parse(text) as Json)
}

export default async function seed({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const link = container.resolve(ContainerRegistrationKeys.LINK)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const fulfillment = container.resolve(Modules.FULFILLMENT)
  const stores = container.resolve(Modules.STORE)
  const regions = container.resolve(Modules.REGION)

  if ((await regions.listRegions({ name: REGION_NAME })).length > 0) {
    throw new Error("This store is seeded already: run sandbox.sh reset for a fresh one.")
  }

  logger.info("Seeding the store: region, sales channel, stock location, shipping")
  const [store] = await stores.listStores()
  const { result: channelResult } = await createSalesChannelsWorkflow(container).run({
    input: { salesChannelsData: [{ name: "Hanza sandbox web shop" }] },
  })
  const channel = channelResult[0]
  // The default sales channel Medusa made stays, without orders: the plugin's sales channel filter has two to choose from.
  await updateStoresWorkflow(container).run({
    input: {
      selector: { id: store.id },
      update: { supported_currencies: [{ currency_code: "pln", is_default: true }], default_sales_channel_id: channel.id },
    },
  })
  const { result: regionResult } = await createRegionsWorkflow(container).run({
    input: { regions: [{ name: REGION_NAME, currency_code: "pln", countries: ["pl"], payment_providers: ["pp_system_default"] }] },
  })
  const region = regionResult[0]
  await createTaxRegionsWorkflow(container).run({ input: [{ country_code: "pl", provider_id: "tp_system" }] })

  const { result: locationResult } = await createStockLocationsWorkflow(container).run({
    input: { locations: [{ name: "Hanza sandbox warehouse", address: { city: "Kraków", country_code: "PL", address_1: "ul. Magazynowa 1" } }] },
  })
  const location = locationResult[0]
  await link.create({
    [Modules.STOCK_LOCATION]: { stock_location_id: location.id },
    [Modules.FULFILLMENT]: { fulfillment_provider_id: "manual_manual" },
  })
  const profiles = await fulfillment.listShippingProfiles({ type: "default" })
  let profile = profiles[0]
  if (!profile) {
    const { result } = await createShippingProfilesWorkflow(container).run({ input: { data: [{ name: "Default Shipping Profile", type: "default" }] } })
    profile = result[0]
  }
  const fulfillmentSet = await fulfillment.createFulfillmentSets({
    name: "Hanza sandbox warehouse delivery",
    type: "shipping",
    service_zones: [{ name: "Poland", geo_zones: [{ country_code: "pl", type: "country" }] }],
  })
  await link.create({
    [Modules.STOCK_LOCATION]: { stock_location_id: location.id },
    [Modules.FULFILLMENT]: { fulfillment_set_id: fulfillmentSet.id },
  })
  await createShippingOptionsWorkflow(container).run({
    input: [
      {
        name: "Standard shipping",
        price_type: "flat",
        provider_id: "manual_manual",
        service_zone_id: fulfillmentSet.service_zones[0].id,
        shipping_profile_id: profile.id,
        type: { label: "Standard", description: "Two to three days.", code: "standard" },
        prices: [
          { currency_code: "pln", amount: 15 },
          { region_id: region.id, amount: 15 },
        ],
        rules: [
          { attribute: "enabled_in_store", value: "true", operator: "eq" },
          { attribute: "is_return", value: "false", operator: "eq" },
        ],
      },
    ],
  })
  await linkSalesChannelsToStockLocationWorkflow(container).run({ input: { id: location.id, add: [channel.id] } })
  const { result: keyResult } = await createApiKeysWorkflow(container).run({
    input: { api_keys: [{ title: "Hanza sandbox storefront", type: "publishable", created_by: "" }] },
  })
  const publishableKey = keyResult[0]
  await linkSalesChannelsToApiKeyWorkflow(container).run({ input: { id: publishableKey.id, add: [channel.id] } })

  logger.info("Seeding the store: six products")
  const single = (title: string, sku: string, amount: number, extra: Json = {}) => ({
    title,
    status: ProductStatus.PUBLISHED,
    shipping_profile_id: profile.id,
    options: [{ title: "Default option", values: ["Default option value"] }],
    variants: [{ title: "Default variant", sku, options: { "Default option": "Default option value" }, prices: [{ amount, currency_code: "pln" }], ...(extra.variant ?? {}) }],
    sales_channels: [{ id: channel.id }],
    ...(extra.product ?? {}),
  })
  await createProductsWorkflow(container).run({
    input: {
      products: [
        single("Mug", "MUG-1", 49.99),
        {
          title: "T-shirt",
          status: ProductStatus.PUBLISHED,
          shipping_profile_id: profile.id,
          options: [{ title: "Size", values: ["S", "M"] }],
          variants: [
            { title: "S", sku: "TSHIRT-S", options: { Size: "S" }, prices: [{ amount: 79, currency_code: "pln" }] },
            { title: "M", sku: "TSHIRT-M", options: { Size: "M" }, prices: [{ amount: 79, currency_code: "pln" }] },
          ],
          sales_channels: [{ id: channel.id }],
        },
        single("Gift card 50", "GIFT-50", 50, { variant: { manage_inventory: false } }),
        single("Coming soon poster", "SOON-1", 29, { product: { status: ProductStatus.DRAFT } }),
        single("Notebook", "NOTE-1", 19.9),
        single("Pen", "PEN-1", 4.99),
      ],
    },
  })
  const { data: inventoryItems } = await query.graph({ entity: "inventory_item", fields: ["id"] })
  const levels: CreateInventoryLevelInput[] = inventoryItems.map((item: Json) => ({ location_id: location.id, stocked_quantity: 100, inventory_item_id: item.id }))
  await createInventoryLevelsWorkflow(container).run({ input: { inventory_levels: levels } })

  logger.info("Seeding the store: five orders through the Store API")
  const { data: variants } = await query.graph({ entity: "product_variant", fields: ["id", "sku"] })
  const variant = (sku: string) => {
    const found = variants.find((candidate: Json) => candidate.sku === sku)
    if (!found) throw new Error(`No variant ${sku}`)
    return found.id as string
  }
  const storeHeaders = { "x-publishable-api-key": publishableKey.token }
  const { token } = await http("POST", "/auth/user/emailpass", {}, {
    email: process.env.MEDUSA_SANDBOX_ADMIN_EMAIL,
    password: process.env.MEDUSA_SANDBOX_ADMIN_PASSWORD,
  })
  const admin = { authorization: `Bearer ${token}` }

  const address = (first_name: string, last_name: string) => ({
    first_name,
    last_name,
    address_1: "ul. Przykładowa 1",
    address_2: "m. 2",
    city: "Kraków",
    postal_code: "30-001",
    country_code: "pl",
    phone: "+48000000000",
  })
  const placeOrder = async (email: string, buyer: [string, string], items: Array<[string, number]>): Promise<Json> => {
    const { cart } = await http("POST", "/store/carts", storeHeaders, {
      region_id: region.id,
      sales_channel_id: channel.id,
      email,
      items: items.map(([sku, quantity]) => ({ variant_id: variant(sku), quantity })),
      shipping_address: address(...buyer),
      billing_address: address(...buyer),
    })
    const { shipping_options } = await http("GET", `/store/shipping-options?cart_id=${cart.id}`, storeHeaders)
    await http("POST", `/store/carts/${cart.id}/shipping-methods`, storeHeaders, { option_id: shipping_options[0].id })
    const { payment_collection } = await http("POST", "/store/payment-collections", storeHeaders, { cart_id: cart.id })
    await http("POST", `/store/payment-collections/${payment_collection.id}/payment-sessions`, storeHeaders, { provider_id: "pp_system_default" })
    const completed = await http("POST", `/store/carts/${cart.id}/complete`, storeHeaders)
    if (completed.type !== "order") throw new Error(`The cart did not become an order: ${JSON.stringify(completed).slice(0, 300)}`)
    return completed.order
  }
  const readOrder = async (id: string) =>
    (await http("GET", `/admin/orders/${id}?fields=id,*items,*fulfillments,*fulfillments.items,*payment_collections.payments`, admin)).order
  const capture = async (id: string) => {
    const order = await readOrder(id)
    for (const collection of order.payment_collections ?? []) {
      for (const payment of collection.payments ?? []) await http("POST", `/admin/payments/${payment.id}/capture`, admin, {})
    }
  }
  const fulfilAndShip = async (id: string) => {
    const order = await readOrder(id)
    const items = order.items.map((item: Json) => ({ id: item.id, quantity: item.quantity }))
    const { order: fulfilled } = await http("POST", `/admin/orders/${id}/fulfillments?fields=id,*fulfillments`, admin, { items, location_id: location.id })
    const created = fulfilled.fulfillments[fulfilled.fulfillments.length - 1]
    await http("POST", `/admin/orders/${id}/fulfillments/${created.id}/shipments`, admin, { items })
  }

  // 1. Left unpaid: the payment is only authorized, so with paid_when = captured the Order awaits payment.
  const unpaid = await placeOrder("buyer-1@example.com", ["Anna", "Nowak"], [["MUG-1", 1]])
  // 2. Paid: captured.
  const paid = await placeOrder("buyer-2@example.com", ["Jan", "Kowalski"], [["NOTE-1", 2]])
  await capture(paid.id)
  // 3. Paid, fulfilled and shipped: closed before Hanza connects.
  const shipped = await placeOrder("buyer-3@example.com", ["Ewa", "Wiśniewska"], [["PEN-1", 3]])
  await capture(shipped.id)
  await fulfilAndShip(shipped.id)
  // 4. Cancelled before payment was captured.
  const cancelled = await placeOrder("buyer-4@example.com", ["Piotr", "Wójcik"], [["TSHIRT-S", 1]])
  await http("POST", `/admin/orders/${cancelled.id}/cancel`, admin)
  // 5. Two lines, paid.
  const twoLines = await placeOrder("buyer-5@example.com", ["Maria", "Kamińska"], [
    ["MUG-1", 1],
    ["TSHIRT-M", 2],
  ])
  await capture(twoLines.id)

  logger.info("Seeding the store: the plugin's settings")
  await http("POST", "/admin/hanza/settings", admin, {
    stock_location_id: location.id,
    sales_channel_ids: [],
    pay_on_delivery_provider_ids: [],
    paid_when: "captured",
    notify_customer_on_shipment: false,
    currency_code: null,
  })

  logger.info(
    `Seeded: stock location ${location.id}, sales channel ${channel.id}, orders ${[unpaid, paid, shipped, cancelled, twoLines].map((order) => order.id).join(", ")}`,
  )
}
