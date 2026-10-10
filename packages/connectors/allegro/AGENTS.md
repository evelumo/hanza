# Allegro connector (`@hanza/connector-allegro`)

The Allegro marketplace (allegro.pl, and the allegro.cz / .sk / .hu Orders that reach the same account). Offers in, Orders in (including Orders still awaiting payment), Stock out, Order phase out. No `price.push`, shipments or invoices yet. Spec: GitHub issue #82; decisions that bind it: ADR 0015, 0019, 0020, 0021, 0022.

Everything in this file about Allegro's behaviour comes from the OpenAPI file (`https://developer.allegro.pl/swagger.yaml`) and the tutorials, not from the sandbox. What could not be checked there is listed at the end, under "Facts not verified against the real API". Check them before trusting a behaviour that depends on one.

## Layout

- `src/settings.ts`: installation settings, config, credentials, hosts, `User-Agent`.
- `src/client.ts`: `request` (never throws on a status), `send` (throws the connector error), `parse` (zod, issue paths only), `errorCodeOf`, `concurrently`.
- `src/auth.ts`: the device flow and refresh (`allegroAuth`).
- `src/api/*`: zod schemas of the responses, only the fields the mapping reads (everything else, PESEL and `messageToSeller` included, is stripped).
- `src/mapping/*`: pure mappers (Offer, Order, Order update, Channel facts, phase → fulfillment status).
- `src/cursor.ts`: the Order feed cursor.
- `src/capabilities/*`: one file per capability.
- `src/testing/`: test tooling only (`@hanza/connector-allegro/testing`): the API simulation, sample payloads, the scrub config. `src/index.ts` never exports it.

## Sign-in and tokens

- **Installation settings** (one registered application per Hanza, Allegro forbids asking sellers for a Client ID): `HANZA_CONNECTOR_ALLEGRO_CLIENT_ID`, `_CLIENT_SECRET`, `_ENVIRONMENT` (`production` default, or `sandbox`), `_APP_NAME` (must equal the registered application name: it goes into the `User-Agent`). Changing the Client ID means signing in again on every Connection.
- **Hosts.** Production: API `https://api.allegro.pl`, OAuth `https://allegro.pl/auth/oauth`. Sandbox: API `https://api.allegro.pl.allegrosandbox.pl`, OAuth `https://allegro.pl.allegrosandbox.pl/auth/oauth`. `deviceFlow.verificationHosts` lists both sites (`allegro.pl`, `allegro.pl.allegrosandbox.pl`), since it is static and the environment is a setting.
- **Device flow, start.** `POST {oauth}/device?client_id=<id>`, `client_id` in the query and no body, `Authorization: Basic base64(clientId:clientSecret)`, `Accept: application/json`. No `scope`: the scopes registered with the application apply (`OAUTH_SCOPES` in `settings.ts` lists what to register: orders read/write, sale offers read/write, profile read).
- **Device flow, poll.** `POST {oauth}/token`, form body `grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=…`, Basic auth. `400 authorization_pending` / `slow_down` / `access_denied` / `expired_token` map to the SDK's poll states; Allegro's non-standard `400 "Invalid device code"` (unknown or already used code) is a `PermanentError`. On approval `GET /me` gives the account (`id`, label = `login`).
- **Refresh.** `grant_type=refresh_token`; the refresh token rotates (the old one works 60 s more, per the tutorial). A `400` with `invalid_grant` or `invalid_token` is `AuthExpiredError` (sign in again); any other OAuth error is `PermanentError`. The core decides when to refresh (ADR 0020).
- **A 401 from the token endpoint** (device start, poll or refresh) refuses the application, not the seller: a wrong client id or secret. It is `PermanentError('401 Unauthorized: check the installation settings')`, never `AuthExpiredError`, since signing in again cannot fix it. A 401 from the API (`/me` included) stays `AuthExpiredError`.
- **Every API request**: `Accept: application/vnd.allegro.public.v1+json`, `Content-Type` the same on a JSON body, `User-Agent: <appName>/<version> (+https://github.com/evelumo/hanza)`, `Authorization: Bearer <accessToken>`.

## Rate limits

Published: 9,000 requests a minute per Client ID (production and sandbox), over it the Client ID is blocked for a minute with 429; plus an unpublished leaky bucket per seller on some resources. Declared: `application: 6000 / 60 s`, `connection: { concurrency: 3 }`. Inside one call at most 3 requests are in flight (`ENDED_BY_LOOKUP_CONCURRENCY`, `CHECKOUT_FORM_CONCURRENCY`, `STOCK_PUSH_CONCURRENCY`). A 429 is `RateLimitedError` with `Retry-After` when present, else the SDK's 60 s, which matches Allegro's one-minute block.

## `offers.pull`

- `GET /sale/offers?limit=1000&offset=<n>&publication.status=ACTIVE&publication.status=ACTIVATING&publication.status=ENDED` (drafts, `INACTIVE`, left out). Cursor = next offset; `hasMore = offset + count < totalCount`. Offset paging can shift while Offers appear; the next hourly pull catches up and the upsert absorbs duplicates.
- One Fulfillment Offers (`isFulfillment: true`) are dropped in the mapper (not filtered in the query: whether `isFulfillment=false` filters is unverified).
- Mapping: `externalId = id`, `sku = external.id`, `url = <site>/oferta/<id>`, `price = sellingMode.price` for `BUY_NOW` / `ADVERTISEMENT` (null for an auction, or when it does not fit `Money`), `status`: `ACTIVE`/`ACTIVATING` → `active`, `ENDED` → `ended`.
- **`endedReason`.** The listing has no `endedBy`. An `ENDED` Offer with stock left cannot have sold out: `other`, no call. One with stock 0 (or none reported) is looked up with `GET /sale/product-offers/{id}`: `publication.endedBy === 'EMPTY_STOCK'` → `sold_out`, anything else → `other`; a 404 there leaves `endedReason` out, so Hanza never reopens it.

## `orders.pull` (ADR 0021)

**Cursor.** Opaque text, two phases, fields URI-encoded and joined by `:` (`src/cursor.ts`):

- `l1:<eventId>:<boughtBefore>:<lastBoughtAt>` while listing the Orders open at the start;
- `e1:<eventId>:<boughtBefore>` in the journal.

`eventId` is empty for a seller whose journal was empty at the start (`GET /order/event-stats` without `latestEvent`); the journal is then read without `from`. `boughtBefore` is the frozen boundary, kept for ever.

**Cursor null.** `GET /order/event-stats` first (journal position), then `boughtBefore` = the time of that answer, from its `Date` header (Allegro's clock: the boundary is compared with Allegro's purchase times, so a skewed local clock would move Orders across it); the local clock only when the header is missing or unreadable. The other way round, an Order placed between the two moments would be neither listed nor sent in full.

**The purchase time** the feed compares and pages by is a form's **latest** `lineItems[].boughtAt` (`boundaryKeyOf`), in both phases: it is what the `lineItems.boughtAt` filters compare ("Latest line item bought date"), and with one key a form whose lines were bought on both sides of the boundary is either listed or sent in full, never neither. The Order's `placedAt` stays the earliest.

**Listing.** `GET /order/checkout-forms?limit=100&sort=lineItems.boughtAt&lineItems.boughtAt.lte=<boughtBefore>&lineItems.boughtAt.gte=<max(lastBoughtAt, boughtBefore - 30 days)>`.

- **No status filters in the query.** The OpenAPI types `status` and `fulfillment.status` of this resource as a single `string` (unlike `publication.status` of `/sale/offers`, an array), so a repeated value is not supported (a server may keep only the last one). The open ones are picked in code: a form is kept unless `status === 'CANCELLED'`, `fulfillment.status` is `SENT`, `PICKED_UP` or `CANCELLED`, or it is One Fulfillment. The simulation honours only the last value of a repeated single-valued parameter, so the tests prove nothing relies on repeating one.
- **Window: `LISTING_WINDOW_DAYS = 30`.** An Order open at connect time is listed only if it was bought at most 30 days before the boundary. Older open Orders (an unpaid one Allegro has not cancelled yet, an Order the seller left unshipped for a month) are not imported; their later journal entries arrive as updates, which the core ignores.
- **Keyset, never offset**, on the purchase time above. The next page starts at `gte` the last key, so the forms sharing it come again (harmless, imports are idempotent) and an Order closing between pages cannot shift the next page. A page that is not full, or a full page whose key did not move (more than 100 Orders bought in the same instant: would loop for ever), ends the listing; its `nextCursor` is the `e1:` cursor with `hasMore: true`. A full page counts every form on it, closed ones too.
- Listed forms become full Orders, `BOUGHT` ones included (Allegro already reserved their units): with the Buyer's account address until the delivery address appears. A form with no usable address at all cannot be a canonical Order (`orderSchema` requires a shipping address; an SDK limit, issue #101): it is sent as an Order update instead (which the core ignores for an Order it does not have) and its form id is logged.

**Journal.** `GET /order/events?from=<eventId>&limit=100`, then `GET /order/checkout-forms/{id}` for each distinct form of the page (events without `order.checkoutForm` are skipped, but still move the cursor). `nextCursor` = `e1:` with the page's last event id; `hasMore` = the page had 100 events; an empty page returns the same cursor with `hasMore: false`. Per form, one item at most (so a full Order and an update of the same Order never share a page):

- latest `lineItems[].boughtAt` **after** `boughtBefore` → a full Order with every fact it has now; when the form is `READY_FOR_PROCESSING`, followed right after it on the page by an Order update of the same form (facts and addresses), because the core takes addresses only from an update: a full Order it already has only adds facts, so without it a paid Order would keep the account address it was imported with while unpaid;
- otherwise an Order update (`kind: 'update'`, the facts, and the shipping and billing addresses when the form is `READY_FOR_PROCESSING`): the core applies it only to an Order it imported, so an Order closed before the Connection is never imported;
- `404` → an update with one fact `{ id: '<formId>:removed', type: 'cancelled', occurredAt: <the form's last event time on the page>, note: 'Merged into another order on the Channel' }` (a merged purchase).

**Skipped:** One Fulfillment forms (`fulfillment.provider.id === 'ALLEGRO'`), in both phases; in the journal, `BOUGHT` / `FILLED_IN` forms with no usable address (neither `delivery.address` nor `buyer.address` with street, city, postal code and country: they come again on a later event). A journal form after the boundary with no usable address that is past checkout (paid, or cancelled before it was ever filled in) goes as an Order update and its form id is logged, as in the listing (issue #101). Such a paid Order is then not imported; not expected in practice (a paid form always has an address).

**Unpaid Orders** (ADR 0015). `BOUGHT` / `FILLED_IN` prepaid forms are Orders with `awaitingPayment: true`, shipped to the Buyer's account address until the delivery address appears at payment. Once paid, the form carries a `paid` fact; before the boundary that arrives as an update with the delivery address, after it as the full Order again followed by that update.

**Expired cursor.** A `400`, `404` or `422` from `GET /order/events` for a request that carried `from` (a journal position) is `CursorExpiredError` when its body is an Allegro error body (`errors[]` with at least one `code`): the journal keeps 60 days, and how Allegro answers an expired `from` is not documented. The same statuses without such a body (a proxy's page, an empty answer) go through `errorFromResponse` (`PermanentError`). The core restarts the feed from null and records it. Reading the statuses this broadly is safe: the core turns a second `CursorExpiredError` in one run, or one for cursor null, into a permanent failure, so a query wrong for another reason cannot loop. Without `from` (a seller whose journal was empty at the start) those statuses stay `PermanentError`; any other failure keeps its class.

## Order status, both directions

Inbound (Channel facts, ids stable per Order, notes always null):

| Fact | When | `occurredAt` |
| --- | --- | --- |
| `<id>:paid` | prepaid, and `payment.finishedAt` set or `status === 'READY_FOR_PROCESSING'` (never for cash on delivery) | `payment.finishedAt`, else `updatedAt` |
| `<id>:shipped` | `fulfillment.status` is `SENT` or `PICKED_UP` | `updatedAt` |
| `<id>:cancelled` | `status === 'CANCELLED'` or `fulfillment.status === 'CANCELLED'` | `updatedAt` |
| `<id>:removed` (type `cancelled`) | the form answers 404 | the event's time |

`READY_FOR_PICKUP`, `SUSPENDED` and `RETURNED` give no fact. Hanza never mirrors Allegro's status.

Outbound (`orders.updateStatus`): `PUT /order/checkout-forms/{id}/fulfillment` with `{ "status": … }` and no `checkoutForm.revision` (Hanza owns the phase; a revision would turn every Buyer edit into a 409): `new` → `NEW`, `processing` → `PROCESSING`, `shipped` → `SENT`, `cancelled` → `CANCELLED`. 204 is done; 404 and 422 are `PermanentError`. `CANCELLED` only sets the seller's label; it refunds nothing.

## `stock.push` (ADR 0022)

One `PATCH /sale/product-offers/{offerId}` with `{ "stock": { "available": n } }` per level, at most 3 in flight, 0 included (0 ends an active Offer). A result for every level:

- 200 / 202 and `n = 0` → `ended` when the answer shows `publication.status: 'ENDED'` (also for an Offer that was already ended), else `ok` (a draft, `INACTIVE`, stays a draft with 0);
- 200 / 202 and `n > 0` → `ok`, unless the answer shows `publication.status: 'ENDED'`: then if `endedBy` is `EMPTY_STOCK` a second `PATCH` `{ "publication": { "status": "ACTIVE" } }` reopens it (`ok`, or `rejected` with that answer's code), else `rejected` with `OFFER_ENDED_<endedBy>` (e.g. `OFFER_ENDED_USER`): an Offer the seller or an admin ended stays ended;
- a 409 on that reopen `PATCH` → `rejected` `OFFER_REOPEN_PENDING`: the stock is set and the stock edit is still being processed (it answered 202); the reopen is tried again on the next push;
- 404 → `rejected` `OFFER_NOT_FOUND`; 400 / 422 → `rejected` with the body's first `errors[].code` (`REJECTED` when it has none that is a plain code);
- 403 → `rejected` `FORBIDDEN` (an Offer of another account), unless every level of the call answered 403: then a missing scope is the likelier cause, and the call fails with `PermanentError`;
- 409 on the stock `PATCH` ("the previous edition is still being processed") → `TransientError` for the whole call: the retry pushes every level again, which is harmless;
- 401, 429, 5xx → the usual error classes for the whole call. An empty array sends nothing.

A 202 whose body does not parse is taken as accepted (`ok`, also for a 0): Allegro is still processing the edit.

## Errors

- `GET /order/events` with `from`: 400, 404 or 422 → `CursorExpiredError` (see "Expired cursor"). Every other non-2xx a capability does not handle itself goes through `errorFromResponse`: 401 → `AuthExpiredError`; a bare 403 stays `PermanentError` (no right to that resource, not signed out: conformance C14); 429 → `RateLimitedError`; 408 / 5xx → `TransientError`; other 4xx → `PermanentError`. A network failure or timeout is `TransientError`; a `ConnectorError` from `ctx.fetch` (the core's rate limiter) passes through unchanged.
- A body that cannot be read (the connection reset, the 30 s timeout firing mid-body) is `TransientError` with the cause, for API and token-endpoint answers alike; a `ConnectorError` raised while reading passes through; a body that is not JSON fails its schema (`PermanentError`).
- Messages never hold a body, a token or Buyer data: only the status, and for a body that fails its schema the issue paths. Only `errors[].code` (and the OAuth `error`) is ever read from an error body, never `message` or `userMessage`.

## Fixtures

- **There is no sandbox recording yet.** The cassettes in `src/fixtures/` were recorded by the SDK recorder from `createFakeAllegroApi()` (`src/testing/fake-allegro-api.ts`), an in-memory simulation of the API subset written from the OpenAPI file: real sandbox URLs, Basic and Bearer checks, the `Accept` check, 401 `invalid_token` for an unknown or revoked token, rotating refresh tokens, the device flow, keyset-able listing (single-valued parameters: the last value wins), the journal with `from`, 404 for a removed form, 0 ending an Offer, 403 / 409 / 422 / 202 on demand (an Offer answered 202 conflicts on its next edit), and a `Date` header on every answer from a fixed data clock. Its seed is `src/testing/samples.ts` (fictitious people; a valid-looking PESEL and real-looking e-mails and phones are put in on purpose, so the scrub config is proven by the lint).
- `src/connector.test.ts` runs the conformance kit (`conformance*.cassette.json`: C1 to C18, with refresh, device flow, `journal: true` and an expired cursor) and the scenario cassettes the kit cannot cover: `offers-pull` (the `endedBy` lookup), `orders-first-pull` (null → listing → journal), `orders-journal` (updates before the boundary, a full Order after it, a 404 → removed, the skips), `orders-unpaid` (awaiting payment, then paid with the delivery address), `orders-listing-pages` (an Order closing between two listing pages), `orders-expired-cursor` and `orders-expired-cursor-422`, `stock-push` (ok, 0 → ended, 0 to a draft, reopen, reopen 409 after a 202, ended by the seller, 422, 403, 404, 202, 409), `orders-update-status` (every phase, 404, 401). Assertions on requests use a spy `fetch` in front of the replay, so they hold in both modes.
- The scrub config keeps the `date` response header, so a replay starts the feed at the recorded boundary and matches the listing's `lineItems.boughtAt` bounds exactly.
- **Record again:** `HANZA_RECORD_FIXTURES=1 pnpm --filter @hanza/connector-allegro exec vitest run src/connector.test.ts`, then read the diff and run the tests without the variable. Recording the same data gives byte-identical files. The scrub config is `src/scrub.ts` (`allegroScrub`).
- **Switching to the sandbox** is a change of the `recording()` setups only: load the sandbox application and a signed-in seller's tokens from `packages/connectors/allegro/.recording/` (git-ignored at the repo root), return them as `app`, `credentials`, `unauthorizedCredentials` (a revoked access token), `refusedRefreshCredentials` (a spent refresh token) and `fetch: globalThis.fetch`. The scenarios script the simulation between calls (`script(...)`); against the sandbox those steps are done by hand or dropped. Use sandbox data you can lose: the run pushes 0 (ending Offers) and every Order phase.

## Facts not verified against the real API

From the spec (#82), phase 1 and this implementation. Each one is an assumption the code makes; check it in the sandbox.

- `lineItems[].price` is the price of one unit after discounts (the OpenAPI types it as a bare `Price`); if it is the line total, `unitPrice` is wrong for quantity > 1.
- `buyer.address` uses `postCode` (not `zipCode`), as the OpenAPI says.
- `order.checkoutForm` may be missing on an event (optional in the OpenAPI); such events are skipped. `updatedAt` and `lineItems[].boughtAt` are optional there too (`placedAt` falls back to `updatedAt`).
- What `GET /order/events?from=` answers for an event older than 60 days or unknown: assumed `400`, `404` or `422` with an Allegro error body (the OpenAPI lists only `422`, "query parameters are incorrect"), all read as `CursorExpiredError` when `from` was sent. Another status (say a 410, or a 200 with an empty page) would not restart the feed: an empty page would leave it silently stuck at that position.
- Whether `from` is exclusive (events after it, as assumed) and whether event ids increase across checkout forms.
- That `sort=lineItems.boughtAt` sorts by the same latest `boughtAt` the filters compare, with a stable order for equal times.
- That `status` and `fulfillment.status` of `GET /order/checkout-forms` really are single-valued (as the OpenAPI types them); the connector no longer depends on it either way.
- That `READY_FOR_PROCESSING` on a prepaid form always means paid, also when `payment.finishedAt` is missing (the `paid` fact then takes `updatedAt`).
- That the `Date` header of `GET /order/event-stats` is Allegro's clock (the boundary's source).
- That an Offer edit answered 202 makes the next `PATCH` of that Offer (the reopen) answer 409 while it is processed, and that a later push may reopen it.
- That a 403 on one Offer's `PATCH` means "not your Offer", while a 403 on every Offer means a missing scope.
- That a draft (`INACTIVE`) Offer given 0 stays `INACTIVE` rather than ending.
- That `PATCH /sale/product-offers/{id}` answers 200 or 202 with the Offer, and that a 202's body shows the publication after the edit.
- `endedBy` after the application sets quantity 0: assumed `EMPTY_STOCK` (if Allegro records `USER`, Hanza never reopens Offers it sold out itself).
- That `PATCH` with `{ "publication": { "status": "ACTIVE" } }` reopens an ended Offer, and whether reopening costs a listing fee.
- The Offer URL pattern `<site>/oferta/<id>`.
- `Retry-After` (or any rate-limit header) on Allegro's 429: not documented; the SDK reads it when present, else waits 60 s.
- Whether Allegro accepts `NEW` after `PROCESSING` on `PUT …/fulfillment`, and what a seller's `CANCELLED` does beyond the label.
- Whether `isFulfillment=false` filters One Fulfillment Offers out of `GET /sale/offers` (not used: the mapper drops them).
- The device request without `scope` (the tutorial is ambiguous on how to pass one).
- Whether the Buyer e-mail is an Allegro relay address.
- Whether line and total currencies always match on allegro.cz / .sk / .hu Orders (the mapper fails the page with `PermanentError` if not).
- Whether a `READY_FOR_PROCESSING` form can still be merged (and so disappear with a 404).
- That a paid form always has a usable address (else it is sent as an update and not imported, see "Skipped").
