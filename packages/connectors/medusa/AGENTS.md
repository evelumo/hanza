# Medusa connector (`@hanza/connector-medusa`)

A `shop` Channel for a **Medusa v2** store through Medusa's Admin API (`<storeUrl>/admin/`) and the routes of the plugin **`medusa-plugin-hanza`** (`/admin/hanza/*`), which the store must have installed. Design record: GitHub issue #171 (the decisions in its last comment are final: the plugin is required, stock goes through the plugin's route, `paid` defaults to `captured`). Registered in `@hanza/connector-registry`, so the panel lists it.

Supported: Medusa **2.8 and later** with `medusa-plugin-hanza` speaking wire format 1, HTTPS. Developed against Medusa **2.21.2**.

> **Status: not yet run against a real Medusa.** The plugin was being written in parallel (`evelumo/medusa-plugin-hanza`). Everything here is read from Medusa 2.21.2's documentation and source code (`node_modules/@medusajs/*` of the sandbox app) and from the plugin's wire format, and tested on an in-memory Medusa (`src/testing/fake-medusa.ts`). The **conformance cassettes are provisional** (see [Tests and cassettes](#tests-and-cassettes)). Facts marked *verified in the source* were read in Medusa's code; facts marked *to verify* are listed in [To verify in the sandbox](#to-verify-in-the-sandbox).

Capabilities: `offers.pull`, `orders.pull`, `stock.push`, `orders.updateStatus`. **No `price.push`** (a follow-up: Medusa prices are per currency, region and price list); `offers.pull` still reports a price so Hanza learns the currency. No `reopensSoldOutOffers` and no `ended` Offers: Medusa keeps a sold-out variant published.

Not read: returns, claims, exchanges, order edits (the journal records them; the connector re-reads the order and reports only its facts), draft orders, tracking numbers, several stock locations per order, inventory kits (refused on push).

## Settings and auth

- `configSchema` (`medusaConfigSchema`): `storeUrl`, the Medusa backend's address (where `/admin` answers), `https:` only. `isStoreUrl` (`src/settings.ts`) is a copy of WooCommerce's hostname guard (no user or password, no `?` or `#`, no IP address, no `localhost`, no host without a dot, no `.local`/`.internal`/`.home.arpa`), duplicated on purpose until the shared guard lands in the core's `ctx.fetch` (#136). Partial hardening only, as in WooCommerce.
- `credentialsSchema` (`medusaCredentialsSchema`): `apiKey`, a Medusa **secret API key** (Settings → Secret API Keys; tied to the admin user who made it, revocable, no expiry). At most 255 printable characters, no whitespace. `auth: { type: 'apiKey' }`; the panel draws it as a password input.
- Sent as `Authorization: Basic <raw key>` (`authorization()` in `src/client.ts`). *Verified in the source:* `getApiKeyInfo` in `@medusajs/framework/dist/http/middlewares/authenticate-middleware.js` takes `Basic sk_…` raw, or base64 of `sk_…:`; a secret key sent as `Bearer` is refused with a hint. A key Medusa does not know answers `401 {"message":"Unauthorized"}`.
- Every request carries `User-Agent: Hanza-Medusa-Connector (+https://github.com/evelumo/hanza)` (`USER_AGENT`), and `redirect: 'manual'`: a followed redirect would turn a `POST` into a `GET` and send the key to another host.
- Responses are read with a 20 MB cap; a body that is not JSON (a proxy's page) or of another shape is a `PermanentError` naming field paths, never values.

### Errors

Through the SDK's `errorFromResponse`, with no `isAuthFailure`, plus the plugin's own signals (`failure()` in `src/client.ts`):

| Answer | Class | Message / meaning |
| --- | --- | --- |
| 401 | `AuthExpiredError` | A revoked or unknown key: "sign in again" (the key is replaced under "Credentials" on the Connection's page) |
| 403 | `PermanentError` | No right to this resource; no sign-in prompt (conformance check C14) |
| 404 on `/admin/hanza/*` | `PermanentError` | `PLUGIN_MISSING_MESSAGE`: "medusa-plugin-hanza is not installed on this store (Medusa answered 404 to /admin/hanza/status): install it, add { resolve: "medusa-plugin-hanza" } to the plugins in medusa-config.ts, run npx medusa db:migrate and restart Medusa" |
| an answer of the plugin whose `format` is not 1 | `PermanentError` | `medusa-plugin-hanza "<version>" speaks wire format <n>; this Hanza understands format 1. …` (`readPluginAnswer` in `src/plugin.ts`; the version is shown only when it looks like one) |
| 410 with `code: journal_expired` on `/admin/hanza/journal` | `CursorExpiredError` | The plugin pruned the cursor's position; the core restarts the feed and records it |
| 409 with `code: stock_location_not_set` on `/admin/hanza/stock` | `PermanentError` | `LOCATION_NOT_SET_MESSAGE`: pick a stock location in Medusa's admin under Extensions → Hanza |
| 429 | `RateLimitedError` | Medusa core has no limit; a proxy may. `Retry-After` honoured |
| 408, 5xx, network failure, timeout, a body that breaks off | `TransientError` | |
| 3xx | `PermanentError` | "The Medusa address redirects elsewhere (<status>)" |
| other 4xx, other 404, other 409 or 410 | `PermanentError` | Status only |

## Rate limits

`rateLimits: { connection: { concurrency: 4 } }`, no rate: Medusa publishes no limit. Every call's requests are sequential, so 4 in flight means 4 jobs of one Connection at once.

## offers.pull

- An Offer is a **product variant**: `externalId` = variant id (`variant_01…`), the id an order line names (`variant_id`).
- `GET /admin/product-variants?order=id&offset=…&limit=…&fields=id,sku,title,manage_inventory,product_id,product.title,product.status,*prices,prices.price_rules.attribute,prices.price_rules.value`. *Verified in the source:* the route (`@medusajs/medusa/dist/api/admin/product-variants/route.js`) maps `prices` to `price_set.prices` and rebuilds each price as `{ id, amount, currency_code, min_quantity, max_quantity, rules }`, `rules` being `{ attribute: value }` built from `price_rules`. **`*prices` alone does not load `price_rules`**, so the two `prices.price_rules.*` fields are requested, or a region's price would pass for a plain one. The remapped price has **no `raw_amount`** and no `price_list_id`.
- `sku`: trimmed, `''` → `null`. `name`: `<product title> - <variant title>`; the product title alone for a variant titled `Default variant` (any case) or untitled; the variant title alone when the product has no title; `#<variant id>` when neither has one. `url`: `null`.
- `status`: `active` iff the product's `status` is `published`, else `inactive` (draft, proposed, rejected). Never `ended`.
- `price`: the variant's **plain** price in the currency `GET /admin/hanza/status` names (`settings.currency_code`, else `store.default_currency_code`), upper-cased: no rules (`rules` empty, `rules_count` 0, `price_rules` empty, `price_list_id` null where present) and `min_quantity` empty or at most 1. From `raw_amount.value` when present, **else from the JSON number written out string-safely** (`numberToDecimal` in `src/decimal.ts`: `String(n)` is the shortest text that reads back as the same double, exponents written out), rounded half-up to 4 places; `null` without such a price, without a currency, or when it does not fit `Money`. (#171 says "from `raw_amount.value`, else `null`"; since the admin route never sends `raw_amount`, that would leave every price `null` and Hanza without the Channel's currency, so the number is read, as the general rule for missing raw twins says.) A price-list price comes back from the remap without its `price_list_id` and looks plain; *to verify* whether `price_set.prices` holds price-list prices, and if so which one comes first.
- **Paging:** offset under `order=id`, which the SDK forbids as a plain offset. Each call after the first starts **one page early** (`offset = consumed − pageSize`, `limit = 2 × pageSize`) and keeps only variants whose id sorts after the last one returned (`lastId`). When the first variant of that window already sorts after `lastId` (more than a page of variants deleted before the position since the last call), the call steps back another page, at most `MAX_STEP_BACKS` = 3 times, then fails as `TransientError`; at offset 0 nothing can be skipped. This relies on Postgres sorting `order=id` the way JavaScript compares the ids: Medusa's ids are a prefix and a ULID (`variant_01J…`: digits and upper-case letters), which sort alike under any collation; *to verify* on a store with imported ids.
- **Cursor** `v1:<currency or ->:<consumed>:<lastId>` (URI-encoded id); unreadable → `PermanentError`. The currency is read once, at cursor `null`, and carried.
- **Requests per call:** 2 in the first (status, page), 1 after, plus at most 3 step-backs. The core's `offers.pull` job makes at most 50 calls per run from `null` (#129): 100 per page is about 5,000 variants.

## stock.push

- One `POST /admin/hanza/stock` with `{ levels: [{ variant_id, available }] }` (a level given twice counts once, with its last number; none → no request). The plugin sets the variant's **availability** at the stock location chosen in its settings: `stocked_quantity = available + reserved_quantity` of the variant's single inventory item, so Medusa's own reservations for orders not shipped yet are kept (decision D3 of #171).
- Its per-variant results map one to one: `ok` → `ok`; `rejected` → `rejected` with the plugin's code (`unknown_variant`, `inventory_not_managed`, `inventory_kit`), or `unknown_error` when the code is missing or not a short machine code. Never `ended`. A result for a variant not in the call is ignored; **a variant the answer leaves out fails the whole call as transient** (`NOT_CONFIRMED_MESSAGE`): it may or may not have been set, so it is neither applied nor refused.
- Whole-call failures: 409 `stock_location_not_set` (above), 404 (plugin missing), another wire format.
- Repeatable: the same numbers twice leave the same state. **Requests per call:** 1.

## orders.pull

A journal feed in ADR 0021's words, like Allegro's: list the orders open at the start once, then follow the plugin's journal for ever. Every call reads `GET /admin/hanza/status` first: its settings decide what is reported (sales channels, pay-on-delivery providers, `paid_when`), and the plugin stamps when Hanza last asked.

1. **Start (cursor `null`).** The journal position **P** = `journal.newest_seq` of that status (0 for an empty journal), **first**; then the boundary **B** = the newest order, `GET /admin/orders?order=-created_at&limit=1&fields=id,created_at`, **second** (any status; drafts are never listed). A store without orders has no B: the feed goes straight to the journal, and every order it names is sent in full. Otherwise the same call reads the first listing page.
2. **Listing.** `GET /admin/orders?status[]=pending&status[]=requires_action&created_at[$gte]=<last time>&created_at[$lt]=<B time + 1 ms>&order=created_at&limit=100&fields=…`, plus `sales_channel_id[]=…` for each sales channel the plugin's settings name (none: every channel). Medusa keeps an order `pending` until someone completes or cancels it, also once it is shipped, so a listed order is **open** (sent in full) or **closed** by its facts (a `shipped` or `cancelled` fact: sent as an Order update with its facts and addresses, ADR 0021 "Feeds built on snapshots"). Medusa sorts on one field only (*verified in the source*, `prepareListQuery`), so the keyset is `created_at` and the cursor carries the ids already dealt with in the last millisecond (`seen`), which the next page, asked from that millisecond on (`$gte`), drops. **B is open by a millisecond** (`$lt` B + 1 ms): Postgres keeps microseconds and answers in milliseconds, so `$lte B` would leave out B itself and orders of the same millisecond. A full page whose newest order is still in the cursor's millisecond (a bulk import made in one transaction stamps every order alike) switches to reading that millisecond **by id** (`created_at[$gte]=T&created_at[$lt]=T+1ms&order=id&offset=…`) with half a page of overlap and `seen`, then goes on after it. A page that is not full ends the listing: the next cursor is the journal's, `hasMore: true`.
3. **Journal.** `GET /admin/hanza/journal?after=<seq>&limit=500`, then the orders the page names, each once (first appearance), re-read as they are now with `GET /admin/orders?id[]=…&limit=<n>&fields=…` in batches of 100. An order placed **after B** (by `created_at`, then id, `isAfterBoundary`) goes in full (with every fact it has); any other as an Order update (facts and addresses). Full Orders come first on a page. An order Medusa does not list any more (deleted, or a draft: the list route always adds `is_draft_order: false`, *verified in the source*) is left out and logged with its id. `hasMore` = the page was full; the next cursor is the last entry's seq; a page with no entries returns the same cursor and `hasMore: false`.
4. **Expired.** 410 `journal_expired` → `CursorExpiredError` (the plugin prunes entries older than `journal_retention_days`, default 60). A cursor the connector cannot read is a `PermanentError`, never an expired one.

**Cursors** (opaque, versioned; fields URI-encoded, so neither `:` nor `,` occurs inside one):

- `l1:<P>:<B time>:<B id>:<last time>:<seen ids, comma-separated>:<tie offset>` while listing (`<last time>` empty before the first page, `<tie offset>` empty outside the by-id read of one millisecond).
- `e1:<seq>:<B time>:<B id>` in the journal (`B` empty for a store that had no orders at the start).

P and B stay in every cursor of the feed. The boundary rule is the same function on every page, so an order is either after B or not, whichever page sees it.

**Which orders could still be lost** (the ADR's consequences, here): an order open at the start that closes before the listing reaches it (it then arrives as an update only); an order created in a transaction that began before B was read and committed after the listing passed its `created_at` (its journal entry comes after P but it counts as placed before B: an update only). The window is the length of the listing. An order whose journal entry the plugin never wrote (a lost subscriber run) is seen only at its next entry; the plugin's reconciliation job is a follow-up.

**Requests per call:** start 3 (status, boundary, first listing page; or status, boundary, journal page and its re-reads for a store without orders); listing 2; journal 2 + one per 100 distinct orders on the page (at most 7 for 500 entries).

### Mapping a Medusa order (`src/mapping/order.ts`, `src/mapping/status.ts`)

| Medusa | Canonical |
| --- | --- |
| `id`, `created_at` | `externalId`, `placedAt` |
| any payment (`payment_collections[].payments[]`) whose `provider_id` is in the plugin's `pay_on_delivery_provider_ids` | `payment: 'cash_on_delivery'`, never awaiting payment, no `paid` fact |
| any other | `payment: 'prepaid'` |
| prepaid and `payment_status` ∈ {`captured`, `partially_refunded`, `refunded`} (plus `authorized` when `paid_when = authorized`) | fact `<id>:paid` at the latest payment `captured_at`, else the order's `updated_at` |
| prepaid with no such fact (`not_paid`, `awaiting`, `authorized` by default, `partially_authorized`, `partially_captured`, `requires_action`, `canceled`) | `awaitingPayment: true` |
| `fulfillment_status` ∈ {`shipped`, `delivered`} | fact `<id>:shipped` at the latest `shipped_at` of the live (not cancelled) fulfillments, else `updated_at`; `partially_shipped`, `partially_delivered`, `fulfilled` are still open (#149) |
| `status: canceled` | fact `<id>:cancelled` at `canceled_at`, else `updated_at`; note `null` |
| `is_draft_order: true`, `status: draft` | never reported (and never listed by Medusa) |
| `total` (`raw_total.value` when present) and `currency_code` upper-cased | `total`, rounded half-up to 4 places |
| `shipping_address` | `shippingAddress`: name `first_name last_name`, else `company`; street `address_1, address_2`; `postal_code`; `city`; `country_code` upper-cased; phone from the address, else `customer.phone`; `taxId` `null` (`province` not mapped) |
| `billing_address` when complete, else `null` | `billingAddress` (no phone fallback) |
| `email`; shipping name (else company, billing name, e-mail) | `buyer` (`phone` as the shipping address's; `login` `null`) |
| item `id`, `variant_id` (`null` when the variant is gone), `variant_sku` (`''` → `null`), `title` (else `product_title - variant_title`), `quantity` (`raw_quantity` when present) | line `externalId`, `offerExternalId`, `sku`, `name`, `quantity` |
| item `total` (`raw_total.value` when present) / `quantity`, exact (`src/decimal.ts`), half-up to 4 places | line `unitPrice`, in the order's currency |
| `shipping_methods[0].name` | `delivery.method`; `pickupPoint: null` |

- `payment_status` and `fulfillment_status` are **computed by Medusa on every order answer** (`getLastPaymentStatus` / `getLastFulfillmentStatus` in `@medusajs/core-flows`, run by the list and detail workflows, *verified in the source*), so they are not in `fields`. The computation counts payment collections (captured vs. amount), so `captured` means every collection is captured.
- **Amounts without raw twins.** Order and item totals are computed and come as JSON numbers only (*verified in the source*: totals are `BigNumber`s serialised as numbers; Medusa's raw columns exist for stored amounts such as `raw_quantity`, `raw_unit_price`). The mapper reads `raw_*.value` wherever present and otherwise writes the number out with `numberToDecimal`; an amount with more significant digits than a double holds would be off in its last digits. `raw_total` is no longer requested, since it is not a field of the order.
- The facts follow the snapshot: once the money was taken the `paid` fact stays, after a refund too, and the Order is never awaiting payment again. A `cancelled` after `paid` is Needs attention in the core (ADR 0003).
- **Orders that do not fit** the canonical Order (no lines, a fractional or non-number quantity, a quantity above 2,147,483,647, no usable shipping address, an amount that is not money): open → skipped and logged (`Medusa order skipped: it does not fit the canonical Order`, with the id and the field paths, never values); closed → an Order update. A problem outside the order's own data (id, dates, facts) is a mapper bug and throws a `PermanentError`.
- An unpaid order without a shipping address does not fit (`orderSchema` requires one, #101) and is skipped while open.

## orders.updateStatus

Reads the order first (`GET /admin/orders/<id>?fields=id,status,*items,*fulfillments,*fulfillments.items,*payment_collections,*payment_collections.payments`), forward only, and skips what is done, so a repeat sends nothing more:

| Phase | Action |
| --- | --- |
| `new`, `processing` | nothing, no request (Medusa has no such status) |
| `shipped` | a cancelled order: nothing (logged). Already `shipped` or `delivered`: nothing. Otherwise `GET /admin/hanza/status`, then, when some item's quantity is not covered by a live fulfillment (summed over `fulfillments[].items[].line_item_id`), `POST /admin/orders/<id>/fulfillments` with `{ items: [{ id, quantity }], location_id }` (the plugin's `stock_location_id`; left out when none is set, so Medusa takes the shipping option's location) and a re-read; then for every live fulfillment without `shipped_at`, `POST /admin/orders/<id>/fulfillments/<fid>/shipments` with its items and `no_notification: !notify_customer_on_shipment` |
| `cancelled` | already cancelled: nothing. A captured payment (`payment_status` captured, partially captured, partially refunded, refunded, or any payment's `captured_at`) or a live fulfillment: nothing, logged ("cancel it in Medusa"): a refund, or a parcel that may have left, is a person's decision in Medusa, which would refuse such a cancel anyway. Otherwise `POST /admin/orders/<id>/cancel` |

- *Verified in the source* (`@medusajs/medusa/dist/api/admin/orders/validators.js`): a fulfillment takes `items`, `location_id` (nullish), `no_notification`, `metadata` (nullish); a shipment takes `items`, `labels` (optional), `no_notification`, `metadata` (nullish), so `metadata` is left out.
- A 404 (order deleted) is a `PermanentError`. Hanza's own fulfillment and shipment make journal entries (`order.fulfillment_created`, `shipment.created`): the Order comes back once through the feed with its `shipped` fact.
- **Requests per call:** `new`/`processing` 0; `shipped` 1 (already shipped) up to 4 + one per unshipped fulfillment; `cancelled` 1 or 2.

## To verify in the sandbox

Each of these is assumed by the code and covered by the in-memory tests, not yet by a real store:

1. Unknown routes: a store without the plugin answers **404** (not 401 or 500) to `GET /admin/hanza/status` with a valid secret key.
2. The list syntax `id[]=…`, `status[]=…`, `sales_channel_id[]=…` (`arrayParam` in `src/client.ts`, the one place to change it) and the operator filters `created_at[$gte]=` / `created_at[$lt]=` with ISO times in milliseconds, through Medusa's `qs` query parser. The validators accept arrays and operator maps (*verified in the source*); the URL spelling is what is left.
3. `created_at` precision: microseconds in Postgres, milliseconds in JSON, and that `$lt` B + 1 ms includes every order of B's millisecond.
4. `order=id` (orders and variants) sorts ids the way JavaScript compares them.
5. Every requested field is accepted and answered: on variants `product.title`, `product.status`, `prices.price_rules.*`; on orders `is_draft_order`, `canceled_at`, `customer.phone`, `*payment_collections.payments` (with `captured_at`), `*fulfillments`, and `*fulfillments.items` (with `line_item_id`) on one order. Whether any amount field the mapper reads carries a `raw_*` twin in an admin answer (`raw_quantity` should).
6. Whether `price_set.prices` of a variant holds price-list prices, which the admin remap shows without `price_list_id`.
7. The payment and fulfillment statuses of the seed's orders as the feed sees them: `authorized` after checkout with `pp_system_default`, `captured` after `POST /admin/payments/<id>/capture`, `shipped` after a fulfillment and its shipment, `canceled` with `canceled_at`.
8. The cancel's refusals (400 or 409) for a captured order and one with a fulfillment.
9. The plugin's answers match the wire format below field for field (format, seq as numbers, the 410 and 409 bodies with `code`), and its journal's hold-back makes recorded journal pages stable.
10. C18 in a recording: the conformance kit asks for `e1:1::` and expects 410, which needs entries pruned past seq 1 (`sandbox/README.md`, "Recording").
11. Not needed by the connector, open in #171: whether `order.updated_at` moves on capture and fulfillment; whether a converted draft order emits `order.placed`.

## Tests and cassettes

- `pnpm --filter @hanza/connector-medusa test` replays everything; no network, no Docker.
- **`src/fixtures/conformance.cassette.json` and `conformance-unauthorized.cassette.json` are PROVISIONAL.** They were generated through the SDK's recorder from the in-memory Medusa (`src/testing/conformance-store.ts`, shaped like the sandbox seed), so the conformance kit runs on the connector's real requests, but every answer is the fake's, not Medusa's: they prove the connector against its own understanding of the API. Re-record them from the sandbox once the plugin exists (`sandbox/README.md`, "Recording"), then drop this paragraph. To regenerate the provisional ones after a change to the connector's requests:

  ```sh
  MEDUSA_RECORDING_SOURCE=fake HANZA_RECORD_FIXTURES=1 pnpm --filter @hanza/connector-medusa exec vitest run src/connector.test.ts
  ```

- `src/connector.test.ts` runs `runConformance` with `journal: true` and `expiredCursor: 'e1:1::'` (the fake pruned through seq 2), without `forbidden: false`.
- Scenario tests run on `FakeMedusa` (`src/testing/fake-medusa.ts`): the plugin's three routes, the variant and order lists with Medusa's query syntax, one order, fulfillments, shipments and the cancel, with a hook to change the store between two requests of a call. It ignores `fields`, has no hold-back, and orders the orders of one millisecond backwards by id, so no test leans on an order Medusa does not promise. Covered: the first pull (listing, then journal, the boundary rule, an order placed between the position and the boundary), a store without orders, keyset pages across a shared millisecond with an order closing between pages, a millisecond holding more than a page, unpaid then paid, cash on delivery, partially shipped (open), cancelled before and after the boundary, sales channel filter, an order that does not fit, journal batches and missing orders, an expired journal, the plugin missing, an unknown format, an unreadable cursor; variants deleted between pages (one page and more than a page), the step-back limit, currencies; stock results including `inventory_not_managed`, `inventory_kit`, `unknown_variant`, 409, an incomplete answer; shipping with and without an existing fulfillment, without a location, a cancelled order; cancelling an unpaid order once, a captured one (no call), one with a fulfillment.
- Scrub config: `src/testing/scrub.ts` (names, company, address lines, city, province, postal code, phone, e-mail, `customer`, `metadata`, `data`). `country_code` is kept. The recording transport turns `''` under scrubbed keys into `null` (#128, as in WooCommerce).
- Replay uses `https://medusa.example.test` (`RECORDING_STORE_URL`) and the stand-in key `sk_replay_secret_key_for_tests`; the recording transport sends that host to the sandbox.

## Layout

```
src/connector.ts        defineConnector; createMedusaConnector({ pageSize?, journalPageSize? }) (options are for tests)
src/settings.ts         medusaConfigSchema, medusaCredentialsSchema, isStoreUrl (copy of WooCommerce's, #136)
src/client.ts           apiUrl, arrayParam, authorization, request, failure (error mapping)
src/plugin.ts           readStatus, readPluginAnswer (the wire format check), offerCurrency
src/api.ts              zod schemas of the answers used, and the fields lists
src/decimal.ts          exact decimal arithmetic on strings, numberToDecimal
src/mapping/            amount.ts (raw twins), offer.ts, order.ts, status.ts (facts, open, phases)
src/capabilities/       offers-pull, orders-pull (+ orders-cursor), stock-push, orders-update-status
src/testing/            fake-medusa, conformance-store, samples, scrub, recording: test tooling only, never imported by the connector
sandbox/                the recording sandbox (Docker): Medusa 2.21.2 with the plugin, its seed, sandbox.sh
```

## Wire format with medusa-plugin-hanza

The contract between this connector and the plugin, version 1, as agreed when both were written (the plugin's repository holds the other copy). Change both together, and bump `format` for anything a connector of the old format would misread.

Spec: https://github.com/evelumo/hanza/issues/171 (read it first; the decisions in its last comment are final).

The plugin `medusa-plugin-hanza` runs inside a merchant's Medusa v2 (≥ 2.8, developed on 2.21.2) and adds admin routes
under `/admin/hanza/*`. They sit behind Medusa's normal admin authentication, so a **secret API key** works
(`Authorization: Basic <token>`, the raw token). Every JSON answer of these routes carries `"format": 1` and
`"plugin": { "name": "medusa-plugin-hanza", "version": "<semver>" }`. Hanza's connector `@hanza/connector-medusa` is the
only client. Everything else (orders, variants, fulfillments, cancel) goes through Medusa's standard Admin API.

Rules for both sides: ids and codes only, never names, addresses, e-mails, phones or amounts in the plugin's tables,
routes, logs or in Hanza's logs/errors. Codes are short slugs `[a-z0-9_]+`. Times are ISO 8601 with `Z`.

### GET /admin/hanza/status

The connector's first call on every run (so the plugin may stamp `last_seen_at`).

```json
{
  "format": 1,
  "plugin": { "name": "medusa-plugin-hanza", "version": "0.1.0" },
  "store": { "default_currency_code": "pln" },
  "settings": {
    "stock_location_id": "sloc_01…" ,            // null until a person picks one in Extensions → Hanza
    "sales_channel_ids": [],                       // [] = every sales channel
    "pay_on_delivery_provider_ids": ["pp_system_default"],
    "paid_when": "captured",                       // "captured" | "authorized"
    "notify_customer_on_shipment": true,
    "journal_retention_days": 60,
    "currency_code": null                          // Offer prices are reported in this currency; null = store default
  },
  "journal": { "oldest_seq": 12, "newest_seq": 980 }   // visible entries only (see hold-back); both null when none
}
```

404 on this route = the plugin is not installed (the connector says so). An unknown `format` = the connector refuses.

### GET /admin/hanza/journal?after=<int>&limit=<int>

Order journal: one entry per Medusa event about an order, written by the plugin's subscribers.

- `after`: required, integer ≥ 0; entries with `seq > after`, ascending by `seq`. `limit`: 1..500, default 100.
- **Hold-back:** only entries whose `recorded_at` (database clock) is older than 5 seconds are returned, and
  `status.journal.newest_seq` is computed the same way. A `bigserial`/autoincrement is handed out before the row
  commits, so a later row can be visible before an earlier one; the hold-back closes that gap on the server, so the
  connector needs no clock of its own.
- Entry: `{ "seq": 981, "type": "order.placed", "order_id": "order_01…", "occurred_at": "2026-10-11T12:00:00.000Z" }`.
  `type` is Medusa's event name as emitted (`order.placed`, `order.updated`, `order.canceled`, `order.completed`,
  `order.archived`, `order.fulfillment_created`, `order.fulfillment_canceled`, `shipment.created`, `delivery.created`,
  `payment.captured`, `payment.refunded`, `order-edit.confirmed`, `order.return_requested`, `order.claim_created`,
  `order.exchange_created`). The connector treats every type the same way: "re-read this order".
- Answer: `{ "format": 1, "plugin": {…}, "entries": [ … ], "newest_seq": 980 }` (`newest_seq` = newest visible, or null).
  `hasMore` on the connector's side is `entries.length === limit`.
- **410 Gone** `{ "type": "gone", "code": "journal_expired", "message": "…", "oldest_seq": 500 }` when `after` is below
  what the plugin still has: `after < pruned_through_seq` (the highest seq the retention job has deleted; 0 when nothing
  was ever pruned). The connector maps it to `CursorExpiredError`.
- 400 for a missing or malformed `after`/`limit` (Medusa's standard `{ type: "invalid_data", message }`).

Retention: a daily job deletes entries older than `journal_retention_days` and records `pruned_through_seq`.

### POST /admin/hanza/stock

Sets the **availability** of up to 100 variants at the settings' stock location, Hanza's number being what a buyer
may still buy: for each variant the plugin writes `stocked_quantity = available + reserved_quantity` of the variant's
single inventory item at that location (creating the level when missing). Repeatable.

Request: `{ "levels": [ { "variant_id": "variant_01…", "available": 12 } ] }` (1..100 items, `available` integer ≥ 0).

Answer 200: `{ "format": 1, "plugin": {…}, "results": [ { "variant_id": "variant_01…", "outcome": "ok" },
{ "variant_id": "variant_02…", "outcome": "rejected", "code": "inventory_not_managed" } ] }`, one result per requested
variant, in any order. Codes: `unknown_variant` (no such variant, or deleted), `inventory_not_managed`
(`manage_inventory: false`, or no inventory item), `inventory_kit` (more than one inventory item).

Whole-call failures: **409** `{ "type": "conflict", "code": "stock_location_not_set", "message": "…" }` while no stock
location is chosen in the settings; 400 for a malformed body.

### Not part of the format (standard Medusa Admin API, used directly by the connector)

`GET /admin/product-variants`, `GET /admin/orders` (listing open orders and re-reading orders named by the journal),
`POST /admin/orders/{id}/fulfillments`, `POST /admin/orders/{id}/fulfillments/{fid}/shipments`,
`POST /admin/orders/{id}/cancel`.

### Admin UI routes of the plugin (not used by the connector)

`GET /admin/hanza/settings` and `POST /admin/hanza/settings` back the settings page (Extensions → Hanza): the settings
above plus `last_seen_at` and the journal counters; `POST` validates that `stock_location_id` and `sales_channel_ids`
exist.
