# WooCommerce connector (`@hanza/connector-woocommerce`)

A `shop` Channel for a WooCommerce store, through its REST API (`<storeUrl>/wp-json/wc/v3/`). Design record: GitHub issue #118. Registered in `@hanza/connector-registry`, so the panel lists it. It is the first real connector; everything below is read from the code and its tests, not from WooCommerce's documentation.

Supported: WooCommerce 7.6 and later (the date filters the Order feed relies on were fixed in 7.6), HTTPS, pretty permalinks. Recorded on WooCommerce 11.2.1 (WordPress 7.1.3, PHP 8.3, MariaDB 11.8.9) with HPOS, the order tables every shop created since WooCommerce 8.2 has; one cassette (`orders-legacy-storage`) is from legacy order storage (orders as posts). The sandbox is a local shop, so nothing here has run against a live one.

Capabilities: `offers.pull`, `stock.push`, `orders.pull`, `orders.updateStatus`. **No `price.push`** (#119): `offers.pull` still reports the Channel price, so Hanza learns the currency. No `reopensSoldOutOffers` and no `ended` Offers: WooCommerce keeps a product published at stock 0.

Not an Offer, not read: grouped and external products, product types a plugin adds, refunds, shipments, tracking numbers, invoices, webhooks (a self-hosted Hanza may have no public address).

## Settings and auth

- `configSchema`: `storeUrl`, the shop's home address as written. `isStoreUrl` (`src/settings.ts`) refuses: anything but `https:`; a user name or password; any `?` or `#`, also an empty one; whitespace, control characters and backslashes; port 0; an IP address (v4 in any spelling, v6), `localhost`, a host without a dot, and names ending in `.local`, `.localhost`, `.internal` or `.home.arpa`. A path is fine (a shop in a subdirectory). `configSchema` also limits the address to 2000 characters. Requests are built from the parsed address (`apiUrl` in `src/client.ts`), never by appending to its text, and `apiUrl` refuses `http:` again for an address stored before the schema did.
- **This is partial hardening.** The worker requests a host a member names, and a public name can resolve to an internal address, at once or later. The guard on the destination belongs in the core's `ctx.fetch` and is tracked separately; do not extend `isPublicHostname` to look like one.
- `credentialsSchema`: `consumerKey`, `consumerSecret` (each at most 255 characters). `auth: { type: 'apiKey' }`. Sent as HTTP Basic (`authorization()` encodes UTF-8), only in the `Authorization` header, which WooCommerce accepts only when WordPress sees TLS. The panel draws both as password inputs.
- Errors go through the SDK's `errorFromResponse`, with no `isAuthFailure`:

  | Answer | Class | Meaning |
  | --- | --- | --- |
  | 401 | `AuthExpiredError` | Unknown or revoked key, wrong secret, **and a read-only key used for a write** (`PUT`, `POST`): all are "sign in again" |
  | 403 | `PermanentError` | The key's user lacks the capability (a subscriber's key): no sign-in prompt, conformance check C14 |
  | 429 | `RateLimitedError` | Core WooCommerce sends none; a host or WAF may |
  | 408, 5xx, network failure, timeout, a body that breaks off | `TransientError` | |
  | other 4xx, a body over 20 MB, not JSON (a WAF or maintenance page), JSON of another shape | `PermanentError` | Messages carry the status or field paths, never a value |
  | 3xx | `PermanentError` | "The shop address redirects elsewhere": requests use `redirect: 'manual'`, because a followed redirect turns a `PUT` into a `GET` (the write is lost behind a 200) and sends the key to another host |

- There is no `isAuthFailure` because WooCommerce already says "signed out" with a 401 and says "not allowed" with a 403; treating a 403 as a sign-out would break C14 and would send a person to sign in with a key that is fine.
- A 404 is "this product, variation or order does not exist" only when WooCommerce's body code says so (`woocommerce_rest_*invalid_id`, `requestIfFound`); any other 404 (`rest_no_route`: wrong address, plain permalinks, WooCommerce off) is a failure.

## Rate limits

`rateLimits: { connection: { concurrency: 2 } }` and nothing else. WooCommerce core has no limit on `wc/v3`. A declared request rate below the connector's natural pace would refuse requests in the middle of a `stock.push` over many variable parents, and the retried call would start over. Each call's requests are sequential.

## offers.pull

- An Offer is a **simple product** (`externalId` `"<productId>"`) or a **variation** of a variable product (`"<parentId>:<variationId>"`). The variable parent is not an Offer. An Order line carries both ids, so no lookup is needed to link a line to its Offer (`lineOfferId`; product id 0 means the product was deleted, and the line has no Offer).
- Skipped: grouped, external and plugin product types (`productKind`). Products in the trash are not listed by WooCommerce. Draft, pending and private products are listed as `inactive`.
- `sku`: `''` becomes `null`. A variation whose SKU is its parent's (WooCommerce reports the parent's SKU when the variation has none) becomes `null`: siblings share it, so it is no key to link by.
- `name`: the product's title (`#<id>` when empty); a variation is `<parent title> - <attribute values>` (`#<id>` when it fixes no attribute).
- `status`: `publish` is `active`, anything else `inactive`; a variation is `inactive` when it or its parent is.
- `price`: the product's `price` (the sale price while on sale) with the shop's currency from `GET data/currencies/current`, read once in the first call and carried in the cursor. `null` when the price is empty, does not fit `Money`, the currency is not an ISO 4217 code (a plugin's points), or the key may not read the currency. **That read needs `manage_woocommerce`, so a catalogue-only key gets a 403; the pull goes on without prices** (`requestIfAllowed`), and such Offers never get a price pushed. The only other place a 403 means "carry on" is the parent-SKU lookup of `orders.pull` (below).
- Paging is by product id, ascending, with the variations of each variable product read page by page. The cursor is opaque and versioned: `o1:<currency or ->:<products page>:<last product id done>` and, while a variable product is only partly read, `:<parent id>:<variations page>:<last variation id>`. It lets a page read again send no Offer twice.
- **Most requests per call: 26** (one page of products and at most `MAX_VARIATION_REQUESTS` = 25 variation requests), **27 in the first call** (the currency). A page that needs more variation requests is finished by the next call. Variations can be listed only per parent (a single list exists from WooCommerce 10.3, above the oldest supported version).
- **The limit that follows: issue #129.** The core's `offers.pull` job makes at most 50 calls per run, always from cursor `null`, and cuts off at the same place every run. At 100 products per page that is about 5,000 simple products, or about 1,250 variable products (50 calls of 25 variation requests); Offers past it are never read, linked or given Stock.
- A product deleted while a pull runs moves the later ones up a page (WooCommerce offers no better paging than a number), and one of them can be missing until the next pull. Both lists must come back in id order or the pull fails (`assertById`): a plugin that reorders the catalogue would lose Offers without a trace.

## stock.push

- Sets `stock_quantity` absolute. Levels are grouped into one `POST products/batch` for the simple products and one `POST products/<parent>/variations/batch` per variable product, **at most 100 items per batch** (`MAX_BATCH_ITEMS`; WooCommerce refuses more with a 413 for the whole batch). Requests are sequential. A level given twice counts once, with its last number.
- **Read before write (simple products only):** one `GET products?include=<ids>&_fields=id,type` per 100 products. `products/batch` sets the number of whatever product has the id, and an Offer that was simple when pulled may be variable now, whose number is the stock every variation on `"parent"` sells from. Only simple ones are sent. A variations batch needs no read: under a missing parent, a parent that is no variable product or one that does not own the variation, WooCommerce refuses each item itself, behind a 200.
- **Every item carries `manage_stock: true`.** The owner decided that a push turns stock management on for the product (Hanza owns Stock, ADR 0001). Without it WooCommerce silently ignores `stock_quantity`.
- Repeatable: the same numbers twice leave the same state. A request that fails rejects the whole call, also when earlier batches were applied; the core retries and the numbers are set again.
- The connector never returns `ended`, also for 0: the product stays published (`stock_status: outofstock`). It returns `rejected` with a `code` for an Offer it did not apply, and for two the shop did write to but that are not Offers any more: a variation in the trash, and a simple product made variable between the read and the write (no conditional write exists). An Offer left out was applied. Codes the connector gives itself (`REJECTION` in `src/capabilities/stock-push.ts`):

  | Code | When |
  | --- | --- |
  | `invalid_offer_id` | The external id is neither `<product id>` nor `<parent id>:<variation id>` |
  | `stock_not_managed` | WooCommerce answered 200 but did not take the number into use: the item answers `manage_stock` other than `true`, or another `stock_quantity` (stock management is off for the whole shop) |
  | `not_a_simple_product` | The id is a product, but no longer a simple one (read first), or the answer's `type` is not the batch's |
  | `not_confirmed` | The batch's answer does not mention the item |
  | `unknown_error` | WooCommerce refused the item with a code that is not a short machine code (letters, digits, `_ . : -`) |
  | `woocommerce_rest_product_invalid_id` | The product is not listed (gone, in the trash, or the id is a variation's), or the answer says its `status` is `trash` |
  | `woocommerce_rest_product_variation_invalid_id` | WooCommerce refused a variation (missing, wrong parent), or the answer says it is in the trash |

  Any other code is WooCommerce's own for the item, passed on when it is a short machine code.
- **A trashed variable product:** its variations go to the trash with it, and WooCommerce still updates them (a 200 with `status: trash`). The connector reports them `woocommerce_rest_product_variation_invalid_id`: `offers.pull` does not list them, so the Offer is gone whatever number it now holds.

## orders.pull

WooCommerce has no event journal, only order snapshots with a modification time, so the feed is built on them. Four rules (ADR 0021's, adapted). The cursor is opaque and never expires: a snapshot is kept for ever, so the connector does not pass `journal` or `expiredCursor` to the conformance kit, C18 does not apply, and a cursor it cannot parse is a `PermanentError` (not `CursorExpiredError`, which would hide the real fault).

1. **Start (cursor `null`).** Two requests: the newest order by id with `status=any`, and the newest with `status=trash` (the trash counts: an order from before the Connection that is restored later must not pass for one placed after). Position **P** is the shop's clock at that moment (the `Date` header of the first answer, in whole seconds) less the hold-back; boundary **B** is the highest id (0 for an empty shop). P is taken first and B second, as the SDK requires; P is earlier than the moment B was read, so an order placed in between is either at most B or stamped after P. Nothing is returned yet (`hasMore: true`).
2. **Listing.** Orders in `pending`, `on-hold`, `processing` (WooCommerce's three open statuses), ordered by creation time then id, paged by keyset, never by plain offset. Each open one is sent as a full Order. An order that closes between two pages leaves the list without moving the others past the position.
3. **Changes.** From P on, every order modified since, from **two lists merged**: `status=any` and `status=trash`, because `any` leaves out `trash` (and the drafts `checkout-draft`, `auto-draft`) and cannot be combined with it. Ordered by modification time then id; the cursor keeps the last `(second, id)` read. **Hold-back:** only entries whose stamped second is at most `shopSecond - holdBack - 1` are reported, with `holdBack` = 20 s (`DEFAULT_HOLD_BACK_SECONDS`), where `shopSecond` is the shop's clock from the `Date` header of the earliest answer of the call. By then the second is over and late commits have landed, so nothing with an earlier stamp can still appear behind the cursor; newer entries wait for the next run. **When the shop sends no `Date` header**, Hanza's own clock stands in, 120 s further behind (`CLOCK_SKEW_ALLOWANCE_SECONDS`), and the call logs it once.
4. **Full Order or update.** An order with id above B, or one still open, is sent as a **full Order**; an order with id at most B that is closed (a `shipped` or `cancelled` fact) is sent as an **Order update** with its facts. A full Order comes before an update of the same order on a page, and an order is on a page once.

**The deliberate deviation from ADR 0021's wording (issue #123).** The ADR says a full Order is sent only for an Order placed after the boundary. This connector also sends an Order from before the boundary in full **while it is open**. The wording would lose every checkout draft opened before the Connection and placed after it (it has an id, and before WooCommerce 10.8 a creation time, before the boundary), and every order in a plugin's status at connection time. The ADR's purpose holds: an order closed before the Connection is never imported, and a snapshot Channel can always tell open from closed. An open order sent twice is harmless (import is idempotent, fact ids are stable). Agreed with the repo owner on 2026-10-10 for this connector; the ADR and the add-connector skill are to be amended (#123).

**Cursors** (decimal whole numbers, no leading zero; only `<second>` may be negative, for an order a shop dates before 1970):

- `l1:<start>:<boundary>:<second>:<id>:<rank>` while listing.
- `c1:<start>:<boundary>:<second>:<id>:<live rank>:<trash rank>` while following the changes.

`<start>` (P) and `<boundary>` (B) stay for the life of the feed. `<second>:<id>` is the last entry dealt with; a rank counts how many entries of that same second were, for each list. A request skips all but the last of them (`offset`) and that one must come back first as the **anchor**, proving no earlier entry left the list since; without it the request steps back (`src/capabilities/orders-stream.ts`, `readRun`: at most 3 requests per list).

**The date filter's format is exact** (`dateFilter`): UTC, whole seconds, a literal `Z` (`2026-10-10T20:45:07Z`), and **no `dates_are_gmt`**. A value with a fraction (what `toISOString()` writes) is read by WooCommerce as site time, and a `Z` value sent with `dates_are_gmt=true` is shifted by the site's UTC offset; both are wrong by an hour or two, silently. The filters are strict (`>`), so the request asks from one second before the position and drops what was dealt with.

**Most requests per call:** start 2; listing at most 6 (3 for the list, 3 lookups of parent SKUs); changes at most 9 (up to 3 for each of the 2 lists, 3 lookups). A page is at most 100 orders per list, so a changes call returns at most 200. The core's `orders.pull` job makes at most 20 calls per run and keeps the cursor between runs, so a long listing is finished by the next run.

**Snapshot to canonical Order** (`src/mapping/order.ts`):

| WooCommerce | Canonical |
| --- | --- |
| `id`, `date_created_gmt` + `Z` | `externalId`, `placedAt` |
| `payment_method: cod` | `payment: 'cash_on_delivery'`, never awaiting payment, no `paid` fact (WooCommerce stamps `date_paid` on `cod` only when it completes) |
| any other method | `payment: 'prepaid'` |
| prepaid and (`date_paid_gmt` set, or status `processing` or `completed`) | fact `<id>:paid` at `date_paid_gmt` (else `date_modified_gmt`) |
| prepaid and no such fact (`pending`, `on-hold`, a plugin's status, or closed without payment) | `awaitingPayment: true` |
| `completed`, or `date_completed_gmt` set | fact `<id>:shipped` at `date_completed_gmt` (else `date_modified_gmt`) |
| `cancelled`, `refunded`, `failed`, `trash` | fact `<id>:cancelled` at `date_modified_gmt`, note `WooCommerce status: <status>` (one of the four, never text a plugin made up) |
| `total` and `currency` | `total` (decimal string, at most 4 fraction digits) |
| `billing` | `buyer` (name from billing, else its company, else the shipping name, else the shipping company; `email`, `phone`); `login` and `taxId` are `null` |
| `shipping`; billing when shipping is wholly empty | `shippingAddress` |
| `billing` when complete, else `null` | `billingAddress` |
| line `id`, `product_id`, `variation_id` | line `externalId`, `offerExternalId` (`"<product>"`, `"<product>:<variation>"` or `null`) |
| line `total + total_tax`, over `quantity` | `unitPrice`, in exact decimal arithmetic (`src/decimal.ts`), rounded half-up to 4 places, in the order's currency |

- The facts follow the snapshot, not the transition: because the `paid` fact follows `date_paid_gmt`, an order moved back to `on-hold` after payment keeps it and is never awaiting payment again. A `failed` order the Buyer pays later gets a `paid` fact after `cancelled`, which the core marks Needs attention (ADR 0003). Never set `awaitingPayment` again once a `paid` fact exists.
- A `shipped` fact outlives the status: `date_completed` stays set when an order moves on from `completed` (refunded, reopened), so it is still shipped. An old WooCommerce wrote `-0001-11-30T00:00:00` for "never"; it, `''` and any non-date read as not set.
- An address field joins `address_1` and `address_2` with `, `; the country code is upper-cased; `state` is not mapped. A shipping address that is filled in but incomplete is **not** replaced by billing (the parcel was meant to go elsewhere); only an empty one is (virtual goods, "ship to billing").
- **Never the float `price` of a line**, which WooCommerce sends as a JSON float, ex-tax.
- **Variation lines and the parent's SKU.** A variation without a SKU of its own reports its parent's, on the order line too. Hanza links a line by Offer first and by exact SKU second, and the variation's Offer has no SKU, so a line that kept the parent's could reserve the Stock of a Product that only happens to have that SKU. For orders sent in full the connector asks for the parents (`GET products?include=<parent ids>&_fields=id,sku`, 100 per request, **at most 3 requests, so 300 parents per call**) and removes the SKU from a variation line that equals its parent's. A line whose parent is unknown (beyond the cap, deleted, in the trash, or the lookup was refused with a permanent error such as 403) loses its SKU too: no SKU leaves the line unlinked and visible, a wrong one reserves another Product's Stock. The call logs it.
- **Orders that do not fit the canonical Order** (no lines, or more than 1000, which is read as none; a fractional quantity or one above 2,147,483,647, the 32-bit column; no usable address; an amount that is not money): when closed, they go as an update; when open, they are skipped and logged (`WooCommerce order skipped: it does not fit the canonical Order`, with the id and the field paths, never values) so the feed is not stopped. A problem outside the order's own data (the id, a date, a fact) is a mapper bug and throws a `PermanentError`.
- `checkout-draft` and `auto-draft` are never requested and dropped if a shop sends one.
- Reading is limited with `_fields` (`WOO_ORDER_FIELDS`), so a response has no notes, IP address, user agent, `order_key` or `meta_data`.

## orders.updateStatus

Reads `GET orders/<id>?_fields=id,status`, then moves the order **forward only** with `PUT orders/<id>?_fields=id,status` and `{ status }`. Reading first keeps the call repeatable (a status already reached is not sent again) and away from closed orders. `set_paid` is never sent.

| Phase | Sets | Only from |
| --- | --- | --- |
| `new` | nothing (no request) | |
| `processing` | `processing` | `pending`, `on-hold`, `failed` |
| `shipped` | `completed` | anything not closed (including a plugin's status such as `packing`) |
| `cancelled` | `cancelled` | anything not closed |

Closed is `completed`, `cancelled`, `refunded`, `failed`, `trash`. `checkout-draft` and `auto-draft` are left alone.

- **A trashed order is never written to**: on HPOS a `PUT` to an order in the trash would take it out again. The read is what notices it.
- **The window is unavoidable:** between the read and the write the Buyer can pay or an admin can complete the order, and the `PUT` then overwrites it. WooCommerce has no conditional write.
- An order deleted for good is a `PermanentError` ("no longer exists in the shop"; a `GET` answers 404 with a WooCommerce code); one deleted between the read and the write answers **400** to the `PUT` (`woocommerce_rest_shop_order_invalid_id`), permanent as well. An external id that is not a WooCommerce order id is permanent.
- Per the design record (#118), `completed` e-mails the Buyer and `cancelled` restores WooCommerce's own stock; that is WooCommerce's behaviour, not ours.
- On HPOS the push bumps `date_modified`, so the order comes back once through the feed. Harmless.

## Known gaps

Each is a follow-up; do not "fix" one in passing.

- **Plugin statuses (#133).** A status the connector does not know counts as open, but only `pending`, `on-hold` and `processing` are listed when a Connection starts. An order waiting in a plugin's status (`packing`) at that moment is imported only when it next changes while still open; if its next change is its completion, it is never imported and its units stay in Hanza's Stock (the cassettes `orders-first-pull` and `orders-listing-close` show it). A plugin's terminal status (`delivered`) leaves the order open in Hanza until someone ships it there or the shop completes it. Listing every registered non-closed status was tried and withdrawn: a plugin that uses a status as a terminal one would reserve Stock for every order a shop ever shipped.
- **Legacy storage and the repeated hour (#134).** On legacy order storage the date filter and ordering are in site time, which runs backwards for an hour when the clocks are set back; changes in that hour can be lost. HPOS filters and sorts on UTC columns and is not affected. Legacy storage also stamps `date_modified` only on status, date, parent or customer-note changes (HPOS on every save), which costs nothing since the feed reports facts, not addresses.
- **An order deleted permanently keeps its Reservation (#122).** Trashing reaches Hanza as a `cancelled` fact. An order deleted for good without passing through the trash disappears from every list; nothing tells Hanza.
- **Orders that do not fit the model are only logged; no tax id (#121).** There is no Event on the Connection for a skipped order. `taxId` is always `null`; plugins keep it in `meta_data`.
- **Shops that drop the `Authorization` header, or use plain permalinks (#120).** Some hosts never pass the header to PHP (answers 401, shown as "sign in again"); with plain permalinks only `?rest_route=` works (answers 404 `rest_no_route`, a `PermanentError`).
- **`price.push` (#119)**, and multi-currency plugins: one shop currency is assumed.
- **The Offers pull cap (#129)**, above.
- **Nothing reopens an Order Hanza already closed.** An order restored from the trash, or moved from `cancelled` back to `processing`, comes back as open and in full, with no `cancelled` fact (a fact is never withdrawn), and the core keeps the Order as it is: a final Order is never reopened by a fact (ADR 0003).
- **The hold-back's assumptions.** A save commits within the 20 s; the `Date` header is the shop's clock (a cache or proxy that answers with its own `Date` breaks it); nobody stamps a modification in the past (a plugin or import that calls `set_date_modified` with an earlier time hides behind the cursor).
- **An order dated before year 1.** `dateFilter` writes such a position with an expanded year (`-000001-…`), which WooCommerce's date validation refuses with a 400, so a listing that reaches an order created at `0000-01-01T00:00:00` cannot move past it. Not tested against a shop; clamp the filter if one ever shows up.
- **The cassette scrubber and empty strings (#128).** See "Tests and cassettes".

## API pitfalls

- Dates of an order are `YYYY-MM-DDTHH:MM:SS` **without a zone**. The `_gmt` twins are UTC, the others site time; read only the `_gmt` ones and add `Z`. `date_paid_gmt` and `date_completed_gmt` are `null` until set.
- `date_modified` is **not monotonic**: it is stamped in PHP before the row is written, so two saves can commit in the opposite order of their stamps, and several saves share one second (a bulk action stamps seven orders with one value). Hence the hold-back, the rank and the anchor.
- `status=any` leaves out `trash`, `checkout-draft` and `auto-draft`, and cannot be combined with `trash`: two requests.
- `modified_after` and `after` are strict and have second resolution. A fraction is read as site time (above).
- `line_items[].price` is a float, ex-tax; `total` and `total_tax` are strings. `sku` of a line is `null` when the product was deleted, together with `product_id` 0. Address fields are `''` when missing (and plugins write `null`: the schemas read both alike). `number` may differ from `id`; the connector uses `id`.
- `POST products/batch` and `POST products/<id>/variations/batch` answer 200 with `{ id, error: { code, message } }` for an item they refused; the message can echo data, only a short code may leave the connector. Over 100 items is refused whole.
- `stock_quantity` is **silently ignored** for a product that does not manage stock. With stock management off for the whole shop the answer is a 200 with `manage_stock: false`: a simple product keeps its number, a variation stores the new one and does not use it.
- A variation without a SKU reports its parent's; `manage_stock` on a variation may be `"parent"`. Variations are listed per parent only, and for a deleted parent WooCommerce 11 answers an empty list (a 404 means the same to the connector).
- Prices are strings (`''` when unset) with no currency. The currency is a settings read that needs `manage_woocommerce`.
- A trashed order has `status: "trash"` and is listed only when `trash` is asked for. `PUT` to a permanently deleted order answers **400**, not 404.
- A key outside `wc/*` is refused since WooCommerce 11.1.0; the connector uses nothing else.
- A page of 100 whole orders is around a megabyte; responses are read with a 20 MB cap, and `_fields` keeps products and orders to the fields the schemas read.

## Tests and cassettes

- `pnpm --filter @hanza/connector-woocommerce test` replays everything: no network, no Docker. `src/connector.test.ts` runs `runConformance` on `conformance.cassette.json` and `conformance-unauthorized.cassette.json`, without `journal`, `expiredCursor` or `forbidden: false`. Capability tests run first against a WooCommerce in memory (`src/testing/orders-fake-shop.ts`, and plain fakes in the offers and stock tests) and then against recorded cassettes through `withScenario` (`offer-scenario.ts`: offers, stock) and `withOrdersScenario` (`orders-scenario.ts`: the feed, status pushes), both built on `src/testing/sandbox.ts`. A replay fails on a request the cassette has no answer for and on an answer nobody asked for.
- Replay uses the neutral address `https://shop.example.test` (`RECORDING_STORE_URL`) and stand-in keys (`replayCredentials`). The sandbox installs itself under the same address, so no link in a recorded response names a machine or port. The shop's `Date` header is kept in every cassette (`keepResponseHeaders`), so no request depends on the clock of the replay.
- **#128 and `blanksToNull`.** The SDK's scrubber replaces any string under a declared key, `''` included, with a placeholder; WooCommerce sends `''` for every address field left out, so a shipping address of virtual goods would come back filled in. The recording transport (`src/testing/recording.ts`, `blanksToNull`) turns `''` under scrubbed keys into `null` before the recorder sees it, and the response schemas read `null` like `''`. The cassettes therefore differ from what WooCommerce really sends. Remove the workaround when #128 is fixed.
- Scrub config: `src/testing/scrub.ts` (names, company, address lines, city, state, postcode, phone, e-mail, customer note, IP address, user agent, transaction id, cart hash, `order_key`, refund reason, `meta_data`). `country` is deliberately not scrubbed: the canonical address needs a real code. Read the diff of every cassette you record.

### The sandbox and how to record

`sandbox/` is a throwaway WordPress + WooCommerce in Docker (`sandbox/README.md` has the commands, the seed ids and how it is set up). Its PHP scripts and its mu-plugin refuse to run on a site whose home URL is not `https://shop.example.test`. Needs Docker and Node.

```sh
S=packages/connectors/woocommerce/sandbox/sandbox.sh
export WOO_SANDBOX_PROJECT=hanza-woo-rec WOO_SANDBOX_PORT=8090   # any free project name and port
$S reset                       # down, up, seed, key: about 50 s
sleep 30                       # see below
HANZA_RECORD_FIXTURES=1 pnpm --filter @hanza/connector-woocommerce exec vitest run src/<file>.test.ts
$S down
```

- **Two instances can run at once** (a different `WOO_SANDBOX_PROJECT` and `WOO_SANDBOX_PORT` each); the default is `hanza-woo-sandbox` on 8089. Keys go to `.recording/credentials[.<project>].json` (git-ignored); the recording setup reads `WOO_SANDBOX_PROJECT` to pick the file. Set `WOO_SANDBOX_PORT` next to `WOO_SANDBOX_PROJECT` whenever a scenario calls `sandbox.sh wp` (the helpers refuse otherwise, because the script would fall back to the default port). **`.recording/` must never be committed, and holds nothing once you are done** (`sandbox.sh down` removes the keys file).
- Run the file directly, not through `pnpm test`: Turborepo hides `HANZA_RECORD_FIXTURES`. A recording is refused when `CI` is set, and not written when it still looks like it holds a secret or personal data.
- **Wait 30 s after `reset`** before recording the conformance cassette or the Order feed. The feed reads only entries older than 20 s on the shop's clock, and check C7 reads each page twice; a shop that was just seeded would show its own seed as changes.
- **Which files change the shop, and the order.** Record each file on a fresh shop (`reset`) unless noted:
  - `src/connector.test.ts` (`conformance*`): pushes stock of 0 and 5 on the first three Offers and moves the first Order (57, the earliest open one) through every phase, ending `completed`. After it the seed is no longer the seed, so never record `orders-pull.recorded.test.ts` on that shop.
  - `src/capabilities/offers-pull.test.ts` (`offers-listing`, `offers-currency-forbidden`, `offers-forbidden`): removes `manage_woocommerce` from the administrator for one scenario and gives it back.
  - `src/capabilities/stock-push.test.ts` (`stock-push`, `stock-gone`, `stock-push-zero`, `stock-not-managed`, `stock-read-only`, `stock-forbidden`): writes stock, trashes and restores products 24 and 17, turns the shop's stock management off and on again.
  - `src/capabilities/orders-pull.recorded.test.ts` (`orders-first-pull`, `orders-listing-close`, `orders-changes`, `orders-unpaid-paid`, `orders-changes-one-second`, the 401 and 403 ones): **all of its scenarios, in file order, from a fresh shop**: the first needs the seed untouched, the later ones close, trash and create orders 58 to 63, which the expectations name (`expectId` fails otherwise).
  - `src/capabilities/orders-update-status.test.ts` (`orders-update-status`, `orders-update-status-read-only`): may follow the feed file on the same shop (it uses orders the feed does not touch) or run on a fresh one.
  - `src/capabilities/orders-pull.legacy.recorded.test.ts` (`orders-legacy-storage`): needs HPOS **off**, which `reset` does not give. After `$S down`: `$S up && $S wp wc hpos disable && $S seed && $S key`, then record. It creates order 58.
- HPOS is on in the sandbox by default (`up` turns it on, because WooCommerce installed through wp-cli would keep orders in posts).
- Recording runs the kit against the sandbox for real: stock pushes of 0 and 5, every Order phase. Use a shop you can lose. After recording, replay without the variable and read the diff: no `localhost`, no port, no key, no `Authorization`, no real name, address, phone or e-mail.
- Re-record on purpose only (a replay miss says the connector's requests changed, or the API did). Placeholders are numbered in order of appearance, so the same data gives the same file.

## Layout

```
src/connector.ts        defineConnector; createWooCommerceConnector({ pageSize?, holdBackSeconds? }) (options are for tests)
src/settings.ts         configSchema, credentialsSchema, isStoreUrl
src/client.ts           apiUrl, authorization, request / requestIfFound / requestIfAllowed, errors, the shop's clock
src/api.ts              zod schemas of the responses used, and the _fields lists
src/decimal.ts          exact decimal arithmetic on strings
src/mapping/            offer.ts (ids, Offers), order.ts (facts, Orders, updates), status.ts (statuses, phases)
src/capabilities/       offers-pull, stock-push, orders-pull (+ orders-cursor, orders-stream, orders-line-skus), orders-update-status
src/testing/            test and recording tooling only, never imported by the connector
sandbox/                the recording sandbox
```
