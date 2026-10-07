---
name: add-connector
description: Add a new marketplace, shop, courier or invoicing connector to Hanza as a package under packages/connectors/<id> against the Connector SDK. Use when asked to "add a connector", integrate an external API (Allegro, WooCommerce, ...), or write offers.pull / orders.pull / stock.push / price.push / orders.updateStatus for a Channel.
---

# Add a connector

A connector is a package that translates one external system into the canonical model of `@hanza/connector-sdk` and back. The core runs it (schedules, retries, stores credentials and cursors); the connector only talks to the external API.

**Reference implementation: `packages/connectors/fake`** (`@hanza/connector-fake`). Read `src/connector.ts` and `src/connector.test.ts` first. It keeps its data in memory, which a real connector must never do; copy its shape, not its state.

**Not supported yet** (do not invent them): `pnpm create-connector`, `pnpm generate` auto-discovery, `pnpm test:connector <id>`, the OAuth authorization-code flow (only the device flow exists), capabilities beyond the five below (no shipments, invoices, webhooks, `offers.push`). Registering a connector in the app is a separate step (`@hanza/connector-registry`, owned by the core; see "Registering").

## Rules

- A connector depends **only** on `@hanza/connector-sdk` and `zod` (`pnpm check:boundaries` fails otherwise). Never import `@hanza/db`, `@hanza/core`, another connector, or `apps/*`.
- No UI, no database access, no module-level state, no `process.env`. The panel draws the connection form from `configSchema`/`credentialsSchema`; the core owns persistence, cursors, retries, rate limits, secrets and, for OAuth, when tokens are refreshed. Settings of the whole installation (an OAuth client id and secret) come from `appConfigSchema` as `ctx.app`, never from the environment directly.
- External API JSON is parsed with zod and mapped by pure functions into the canonical `Offer` / `Order`. Money is a decimal string (`"129.99"`, at most 4 fraction digits) plus ISO currency, never a float.
- Throw the SDK's error classes (below), never plain `Error`, and never put secrets, tokens, response bodies or Buyer data in an error message: the message is stored and shown in the panel.
- Never log credentials or personal data.
- **If you need to change the SDK or the core to finish, stop and write a spec** as a GitHub issue (`AGENTS.md`, "Specs, decisions and vocabulary"). That includes the canonical model.
- Tests are deterministic: recorded fixtures, no network, no real accounts or keys.

## The SDK in short (read `packages/connector-sdk/src` for the details)

```ts
defineConnector({
  id: 'allegro',                 // /^[a-z][a-z0-9-]*$/
  name: 'Allegro',
  kind: 'marketplace',           // 'marketplace' | 'shop' | 'courier' | 'invoicing'
  auth: { type: 'oauth2', refresh, expiresAt, deviceFlow },  // | { type: 'apiKey' } | { type: 'none' }; the three hooks are optional
  appConfigSchema,               // optional; installation settings from HANZA_CONNECTOR_<ID>_<FIELD>, passed as ctx.app
  configSchema,                  // z.object of string / number / boolean / enum fields (renders the panel form)
  credentialsSchema,             // same shape rules; stored encrypted; z.object({}) if none
  capabilities: { ... },
})
```

A **Channel** (`marketplace` or `shop`) must implement `offers.pull`, `orders.pull` and `stock.push`; `defineConnector` throws otherwise. `price.push` and `orders.updateStatus` are optional. Couriers and invoicing tools implement what they support.

| Capability | Contract |
| --- | --- |
| `offers.pull(ctx, cursor)` | Every Offer on the Channel, paged. The engine always starts from `null`. Returns `{ items: Offer[], nextCursor, hasMore }`. Set `price` (the Offer's current price on the Channel) whenever the API gives it: Hanza only records it, and uses its currency to decide whether it may push a price (ADR 0011). It must be valid `Money`: a decimal string with at most 4 decimal places and an upper-case ISO 4217 currency. A schema violation fails the whole page, as for any field, so report `price: null` rather than a value that does not fit. |
| `orders.pull(ctx, cursor)` | Incremental feed of Orders: new ones, and ones that got new Channel facts. The same cursor must give the same page. Only Orders **ready to fulfil** (paid, or cash on delivery), unless you also report unpaid ones (see "Unpaid Orders"). |
| `stock.push(ctx, levels)` | Set absolute availability for up to 100 Offers (`{ offerExternalId, sku, available }`). Must be repeatable. |
| `price.push(ctx, prices)` | Optional. Set the price of up to 100 Offers (`{ offerExternalId, sku, price: { amount, currency } }`). The currency is always the one your `offers.pull` reported for that Offer; Hanza never converts and never pushes to an Offer without a reported price. Must be repeatable. Implement it only if the Channel lets you set prices. |
| `orders.updateStatus(ctx, { orderExternalId, status })` | Translate an Order phase (`new`, `processing`, `shipped`, `cancelled`; the SDK type is still called `OrderStatus`) to the Channel's own status and set it. Resolve without a call if the Channel has no equivalent. Must be repeatable. |

`CapabilityContext` gives you `app` (installation settings, parsed with `appConfigSchema`; `{}` without one), `config` (parsed with `configSchema`), `credentials` (parsed with `credentialsSchema`), `fetch` (global fetch with a 30 s timeout; **you** add the authentication to your requests) and `log`.

Paging: `nextCursor` is the position to resume from; when `hasMore` is true it must be non-null and differ from the input cursor. In `orders.pull` the feed is a journal: a cursor past the last entry returns `{ items: [], hasMore: false }`.

Status translation is connector code. Inbound: the Channel's statuses and events decide which Orders you return and which **Channel facts** (`facts[]`, types `cancelled`, `shipped` and `paid`, each with an id that is stable for that Order) you attach. Hanza does not mirror the Channel's status. Outbound: `orders.updateStatus` maps the four Order phases to the Channel's statuses. Connectors speak phases only: an organization's own Order statuses are labels within a phase that never reach a connector, and the per-Channel Status mapping is data in the core (ADR 0018).

**Unpaid Orders** (optional, ADR 0015). If the Channel exposes Orders before they are paid, return them with `awaitingPayment: true` (prepaid only; `orderSchema` rejects it on cash on delivery or next to a `paid` fact). Hanza imports and reserves them but will not fulfil them. A Buyer who never pays is a `cancelled` fact. A connector that leaves `awaitingPayment` out must return only ready Orders, as before. Two rules:

- **The payment is a `paid` fact, which you synthesize.** Most APIs only give a payment status on the Order snapshot. When it says paid, set `awaitingPayment` to false **and** add a fact `{ id: \`${orderId}:paid\`, type: 'paid', occurredAt: <payment time, or the time the status changed>, note: null }`, with the same id on every later pull. Hanza reads the flag only on the first import, so dropping it without the fact leaves the Order awaiting payment for good (the core logs a warning, and conformance check C6 fails when your fixtures' journal shows it).
- **Once a `paid` fact exists, never set `awaitingPayment` back to true** (a chargeback, a refund, a payment the Channel reverses). An Order with both breaks `orderSchema`, and one such Order turns the whole page into a `PermanentError` that stops the Connection's Order feed. Keep reporting it as paid; refunds are not modelled yet.

Canonical schemas (all exported): `offerSchema`, `orderSchema` (with `buyerSchema`, `addressSchema`, `orderLineSchema`, `channelFactSchema`), `stockLevelSchema`, `offerPriceSchema`, `moneySchema`. Use the glossary in `packages/connector-sdk/CONTEXT.md` for names (Offer, Order, Buyer, Channel fact, Channel price; not "listing", "customer", "external status").

### OAuth (optional, ADR 0020)

- **Installation settings.** Allegro-like Channels forbid asking each user for a client id and secret: the operator registers one application per installation. Declare `appConfigSchema` (flat, like `configSchema`); field `clientId` of connector `allegro` is read from `HANZA_CONNECTOR_ALLEGRO_CLIENT_ID`. While a required field is missing the panel lists the connector as not set up, and runs of existing Connections fail `permanent` naming the variables.
- **Refresh.** Put the access token's expiry in the credentials and return it from `auth.expiresAt(credentials)`. Implement `auth.refresh(ctx, credentials)` to return the new credentials, rotated refresh token included; throw `AuthExpiredError` when the Channel refuses the refresh token (an OAuth `400 invalid_grant` is such a signal: pass `isAuthFailure` to `errorFromResponse`, since a bare 400 or 403 is `permanent`). Never refresh inside a capability: the core refreshes 15 minutes before expiry, and once after a capability throws `AuthExpiredError` (then it retries that call), serialised per Connection, and stores the result before it is used. Token and device-flow requests go through the same rate-limited `ctx.fetch` as capabilities, so they count against `rateLimits`.
- **Sign-in (device flow).** `auth.deviceFlow = { start, poll, verificationHosts }`: `start(ctx)` asks the Channel for a device code and returns `{ deviceCode, userCode, verificationUri, verificationUriComplete, expiresInSeconds, intervalSeconds }`; `poll(ctx, deviceCode)` returns `pending`, `slow_down`, `denied`, `expired`, or `approved` with the credentials and the Channel account `{ id, label }` (e.g. from a "who am I" call). "Sign in again" refuses another account id. `verificationHosts` lists the hosts the link may point to; the panel shows only `https:` links on them. With a device flow, credentials are never shown as form fields.
- **Conformance.** Through `runConformance`: with `appConfigSchema` pass `app` (its secret fields, e.g. `clientSecret`, are scrubbed like credentials; name more in `appSecrets`); with `auth.refresh` pass `refresh: { refused: { credentials } }` (C15 replays `conformance-refresh.cassette.json` and `conformance-refresh-refused.cassette.json`: the refreshed credentials match the schema, a refused one fails `auth_expired`); with `auth.deviceFlow` pass `deviceFlow: true` (C16 replays `conformance-device-flow.cassette.json`: `start`, then one `poll`). The recording setup may return the real `app` and `refusedRefreshCredentials`. `fake-http-oauth` (`packages/connectors/fake/src/http/oauth-connector.test.ts`) is the worked example.

### Errors

| Class | Use it when | The engine |
| --- | --- | --- |
| `AuthExpiredError` | the credentials are no longer accepted: 401, `WWW-Authenticate: Bearer error="invalid_token"`, or the Channel's own signal (a refused refresh token) | stops retrying, marks the Connection as needing sign-in |
| `RateLimitedError(msg, { retryAfterMs })` | 429 or an explicit limit | retries after the delay without using an attempt |
| `TransientError` | network failure, timeout, 5xx | retries with backoff |
| `PermanentError` | 4xx other than the above, including a 403 (no right to this resource: another seller's Offer, a missing scope), unexpected response shape, unsupported request | stops retrying, marks the Connection as failing (not signed out) |

`errorFromResponse(response, options?)` maps an HTTP status to the right class (never including the body); use it for every non-2xx response. A 403 is `PermanentError` unless it carries an auth signal: if your Channel has its own (an OAuth body `{"error":"invalid_grant"}`, or a 403 that really means "signed out"), pass `{ isAuthFailure: (response) => ... }`, which may read the body; document it in the connector's `AGENTS.md`. A `ZodError` from parsing is classified as permanent, a `TypeError` from `fetch` or a timeout as transient. Wrap anything else you can recognise, but let a `ConnectorError` that `ctx.fetch` rejects with through unchanged: the core's rate limiter rejects with `RateLimitedError` before sending when the budget is used up.

### Rate limits

Declare the Channel's limits in `defineConnector({ rateLimits })`, set below the published ones for headroom; the core enforces them in `ctx.fetch` across every worker (ADR 0019), so never count requests yourself:

- `application: { requests, windowMs }`: one budget for every Connection of this connector on the installation (the API application's limit, e.g. per Client ID);
- `connection: { rate?: { requests, windowMs }, concurrency? }`: per Connection (one account on the Channel).

A request waits up to 2 s for its slot, or `ctx.fetch` rejects with `RateLimitedError`. A 429 parks every budget of that request for its `Retry-After` (60 s when absent). Write the Channel's limits and what you declared in the connector's `AGENTS.md`.

## Procedure

1. **Check scope.** Read `AGENTS.md` and `packages/connectors/README.md`. Confirm the Channel's API can be expressed with the five capabilities and the canonical `Offer` / `Order` fields. If it needs something the model lacks (variants, tax breakdown, shipments, ...), stop and write a spec (a GitHub issue).
2. **Pick the id.** Lowercase slug (`allegro`, `woocommerce`). Package `@hanza/connector-<id>`, directory `packages/connectors/<id>/`.
3. **Create the package** (copy `packages/connectors/fake`): `package.json` with `"exports": { ".": "./src/index.ts" }`, `dependencies` of only `@hanza/connector-sdk` (`workspace:*`) and `zod`, `devDependencies` of `typescript`, `vitest` and `@types/node` (same versions as the fake; the recorded-fixture tools in `@hanza/connector-sdk/testing` use Node's `fs`), and the same `tsconfig.json` (`DOM` lib gives the `fetch` types, `types: ["node"]` the Node ones). Run `pnpm install` once to create the workspace link.
4. **Lay out the sources** under `src/`:

   ```
   packages/connectors/<id>/
   ├── package.json  tsconfig.json
   ├── AGENTS.md              # API pitfalls: quirks, rate limits, pagination, status mapping, sandbox notes
   └── src/
       ├── index.ts           # re-exports the connector
       ├── connector.ts       # defineConnector({ id, name, kind, auth, configSchema, credentialsSchema, capabilities })
       ├── client.ts          # thin helpers over ctx.fetch: URL building, auth header, zod-parsed responses, errorFromResponse
       ├── capabilities/      # one file per capability: offers-pull.ts, orders-pull.ts, stock-push.ts, price-push.ts, orders-update-status.ts
       ├── mapping.ts         # pure functions: external JSON <-> canonical Offer / Order / StockLevel / OfferPrice
       ├── fixtures/          # recorded cassettes (<scenario>.cassette.json), scrubbed
       └── connector.test.ts
   ```

5. **Define `configSchema` and `credentialsSchema`.** Non-secret settings (base URL, shop id, environment) go in `configSchema`; API keys and tokens go in `credentialsSchema`. Only flat fields: string, number, boolean or enum, with `.describe('...')` for the label. Nested objects, arrays and unions fail the conformance kit because the panel cannot draw them.
6. **Write the external-response schemas** (zod) for the parts of the API you use. Parse every response; fail loudly on shape drift (as a `PermanentError` with `cause`, not a raw `ZodError`). No `any`.
7. **Write `mapping.ts`**: pure, synchronous, no I/O. Keep API amount strings as they are; if the API returns numbers, format them string-safely and test rounding. `placedAt` and fact `occurredAt` must be ISO datetimes with an offset or `Z`. Every line's `unitPrice.currency` equals the Order's `total.currency`. End each mapper with `offerSchema.parse(...)` / `orderSchema.parse(...)` so an invalid canonical object cannot leave the connector. Wrap a parse failure in `PermanentError` (with `cause`) instead of letting the raw `ZodError` escape a capability: conformance check C12 requires every rejection to be a `ConnectorError`.
8. **Implement capabilities.** Use only `ctx.fetch`, `ctx.config`, `ctx.credentials`, `ctx.log`. Idempotent and repeatable; no module-level state. Implement only what the Channel supports (a Channel still needs the three required ones).
9. **Assemble `connector.ts`** and export it from `src/index.ts`.
10. **Record fixtures** with the recorder (`packages/connectors/README.md`, "Recorded fixtures"; the reference is `packages/connectors/fake/src/http/`):
    - Write the connector's `ScrubConfig`: every personal field the API sends (names, addresses, postal codes, tax and national ids, logins, notes) by key or path. Tokens, credential headers, `Bearer`/JWT strings, real e-mails and `+` phone numbers are scrubbed by default.
    - Put the sandbox credentials in `packages/connectors/<id>/.recording/` (ignored by git); the test's `recording()` reads them. Never anywhere else.
    - Record with `HANZA_RECORD_FIXTURES=1 pnpm --filter @hanza/connector-<id> exec vitest run src/connector.test.ts`. A recording that still looks like it holds a secret or personal data is not written: declare the field and record again. Read the diff before committing.
    - Cover edge cases with scenario cassettes (`openCassette`): empty page, last page, cancelled Order, multi-line Order, an unpaid Order (returned with `awaitingPayment: true` and later with a `paid` fact, or not returned at all if you do not report unpaid Orders), an unknown status, error statuses.
    - Without a sandbox, hand-write cassettes from the official docs (same format) and say so in the connector's `AGENTS.md`; the lint checks them too.
11. **Write `connector.test.ts`** (Vitest, no network):
    - call `runConformance(connector, { fixtures, config, credentials, unauthorized, scrub, recording })` (plus `app`, `refresh` and `deviceFlow` for an OAuth connector, see "OAuth" above) from `@hanza/connector-sdk/testing`: it lints the fixtures, replays `conformance.cassette.json` (and `conformance-unauthorized.cassette.json`, where the API answers 401) and runs `assertConformance`. Test credentials stand in for the recorded ones (8+ characters). It checks the schemas, paging and cursors, idempotent re-pulls, repeatable pushes and error classes, including that a bare `403 Forbidden` does not ask for sign-in (C14; pass `forbidden: false` only if your Channel signs out with 403, and say why in `AGENTS.md`) (checks C1 to C16, see `packages/connector-sdk/src/testing/conformance.ts`; with `price.push`, C13 needs at least one fixture Offer that reports a `price`), and reports every request the cassettes could not answer;
    - add tests for what the kit cannot know: the mapper output for every fixture (amounts, currency, facts), the status mapping in both directions, the request bodies of `stock.push`, `price.push` and `orders.updateStatus`, and each error class from the matching HTTP status.
12. **Validate** (run what you can; report what you could not):

    ```sh
    pnpm check:boundaries
    pnpm --filter @hanza/connector-<id> typecheck
    pnpm --filter @hanza/connector-<id> test
    pnpm typecheck && pnpm test      # whole repo
    ```

13. **Write the connector's `AGENTS.md`**: auth flow, rate limits, pagination and cursor semantics, status mapping, sandbox URL, API quirks, how fixtures were recorded.
14. **Registering.** Making a connector selectable in the panel is one dependency and one line in `packages/connector-registry` (the core never imports connectors). Do that only if the task asks for it and the registry exists in your checkout.
15. **Report**: files created, capabilities implemented, anything the SDK could not express (input for a spec; do not work around it by touching the SDK or core).

## Definition of done

- `pnpm check:boundaries`, typecheck and tests pass, including `runConformance` on recorded cassettes.
- Only `@hanza/connector-sdk` and `zod` in `dependencies`.
- No `process.env`, no database, no module-level state, no imports outside the SDK, no UI, no real credentials or personal data in fixtures (the lint passes) or error messages.
- Every external response is zod-parsed; every canonical object is validated against the SDK schema.
- The connector's `AGENTS.md` documents the API's pitfalls.
