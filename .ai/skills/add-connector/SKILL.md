---
name: add-connector
description: Add a new marketplace, shop, courier or invoicing connector to Hanza as a package under packages/connectors/<id> against the Connector SDK. Use when asked to "add a connector", integrate an external API (Allegro, WooCommerce, ...), or write offers.pull / orders.pull / stock.push / orders.updateStatus for a Channel.
---

# Add a connector

A connector is a package that translates one external system into the canonical model of `@hanza/connector-sdk` and back. The core runs it (schedules, retries, stores credentials and cursors); the connector only talks to the external API.

**Reference implementation: `packages/connectors/fake`** (`@hanza/connector-fake`). Read `src/connector.ts` and `src/connector.test.ts` first. It keeps its data in memory, which a real connector must never do; copy its shape, not its state.

**Not supported yet** (do not invent them): `pnpm create-connector`, `pnpm generate` auto-discovery, `pnpm test:connector <id>`, OAuth flows and token refresh in the core (stage 2, with Allegro), a recording tool for fixtures, capabilities beyond the four below (no shipments, invoices, webhooks, `offers.push`). Registering a connector in the app is a separate step (`@hanza/connector-registry`, owned by the core; see "Registering").

## Rules

- A connector depends **only** on `@hanza/connector-sdk` and `zod` (`pnpm check:boundaries` fails otherwise). Never import `@hanza/db`, `@hanza/core`, another connector, or `apps/*`.
- No UI, no database access, no module-level state, no `process.env`. The panel draws the connection form from `configSchema`/`credentialsSchema`; the core owns persistence, cursors, retries, rate limits and secrets.
- External API JSON is parsed with zod and mapped by pure functions into the canonical `Offer` / `Order`. Money is a decimal string (`"129.99"`, at most 4 fraction digits) plus ISO currency, never a float.
- Throw the SDK's error classes (below), never plain `Error`, and never put secrets, tokens, response bodies or Buyer data in an error message: the message is stored and shown in the panel.
- Never log credentials or personal data.
- **If you need to change the SDK or the core to finish, stop and write a spec** (`.ai/specs/TEMPLATE.md`). That includes the canonical model.
- Tests are deterministic: recorded fixtures, no network, no real accounts or keys.

## The SDK in short (read `packages/connector-sdk/src` for the details)

```ts
defineConnector({
  id: 'allegro',                 // /^[a-z][a-z0-9-]*$/
  name: 'Allegro',
  kind: 'marketplace',           // 'marketplace' | 'shop' | 'courier' | 'invoicing'
  auth: { type: 'oauth2' },      // | { type: 'apiKey' } | { type: 'none' }
  configSchema,                  // z.object of string / number / boolean / enum fields (renders the panel form)
  credentialsSchema,             // same shape rules; stored encrypted; z.object({}) if none
  capabilities: { ... },
})
```

A **Channel** (`marketplace` or `shop`) must implement `offers.pull`, `orders.pull` and `stock.push`; `defineConnector` throws otherwise. `orders.updateStatus` is optional. Couriers and invoicing tools implement what they support.

| Capability | Contract |
| --- | --- |
| `offers.pull(ctx, cursor)` | Every Offer on the Channel, paged. The engine always starts from `null`. Returns `{ items: Offer[], nextCursor, hasMore }`. |
| `orders.pull(ctx, cursor)` | Incremental feed of Orders **ready to fulfil** (paid, or cash on delivery): new ones, and ones that got new Channel facts. The same cursor must give the same page. |
| `stock.push(ctx, levels)` | Set absolute availability for up to 100 Offers (`{ offerExternalId, sku, available }`). Must be repeatable. |
| `orders.updateStatus(ctx, { orderExternalId, status })` | Translate a Hanza Order status (`new`, `processing`, `shipped`, `cancelled`) to the Channel's own and set it. Resolve without a call if the Channel has no equivalent. Must be repeatable. |

`CapabilityContext` gives you `config` (parsed with `configSchema`), `credentials` (parsed with `credentialsSchema`), `fetch` (global fetch with a 30 s timeout; **you** add the authentication to your requests) and `log`.

Paging: `nextCursor` is the position to resume from; when `hasMore` is true it must be non-null and differ from the input cursor. In `orders.pull` the feed is a journal: a cursor past the last entry returns `{ items: [], hasMore: false }`.

Status translation is connector code. Inbound: the Channel's statuses and events decide which Orders you return and which **Channel facts** (`facts[]`, stage 1 types `cancelled` and `shipped`, each with an id that is stable for that Order) you attach. Hanza does not mirror the Channel's status. Outbound: `orders.updateStatus` maps the four Hanza statuses to the Channel's.

Canonical schemas (all exported): `offerSchema`, `orderSchema` (with `buyerSchema`, `addressSchema`, `orderLineSchema`, `channelFactSchema`), `stockLevelSchema`, `moneySchema`. Use the glossary in `packages/connector-sdk/CONTEXT.md` for names (Offer, Order, Buyer, Channel fact; not "listing", "customer", "external status").

### Errors

| Class | Use it when | The engine |
| --- | --- | --- |
| `AuthExpiredError` | credentials rejected (401/403), token expired | stops retrying, marks the Connection as needing sign-in |
| `RateLimitedError(msg, { retryAfterMs })` | 429 or an explicit limit | retries after the delay without using an attempt |
| `TransientError` | network failure, timeout, 5xx | retries with backoff |
| `PermanentError` | 4xx other than the above, unexpected response shape, unsupported request | stops retrying, marks the Connection as failing |

`errorFromResponse(response)` maps an HTTP status to the right class (never including the body); use it for every non-2xx response. A `ZodError` from parsing is classified as permanent, a `TypeError` from `fetch` or a timeout as transient. Wrap anything else you can recognise.

## Procedure

1. **Check scope.** Read `AGENTS.md` and `packages/connectors/README.md`. Confirm the Channel's API can be expressed with the four capabilities and the canonical `Offer` / `Order` fields. If it needs something the model lacks (variants, tax breakdown, shipments, ...), stop and write a spec.
2. **Pick the id.** Lowercase slug (`allegro`, `woocommerce`). Package `@hanza/connector-<id>`, directory `packages/connectors/<id>/`.
3. **Create the package** (copy `packages/connectors/fake`): `package.json` with `"exports": { ".": "./src/index.ts" }`, `dependencies` of only `@hanza/connector-sdk` (`workspace:*`) and `zod`, `devDependencies` of `typescript` and `vitest` (same versions as the fake), and the same `tsconfig.json` (`DOM` lib gives the `fetch` types). Run `pnpm install` once to create the workspace link.
4. **Lay out the sources** under `src/`:

   ```
   packages/connectors/<id>/
   ├── package.json  tsconfig.json
   ├── AGENTS.md              # API pitfalls: quirks, rate limits, pagination, status mapping, sandbox notes
   └── src/
       ├── index.ts           # re-exports the connector
       ├── connector.ts       # defineConnector({ id, name, kind, auth, configSchema, credentialsSchema, capabilities })
       ├── client.ts          # thin helpers over ctx.fetch: URL building, auth header, zod-parsed responses, errorFromResponse
       ├── capabilities/      # one file per capability: offers-pull.ts, orders-pull.ts, stock-push.ts, orders-update-status.ts
       ├── mapping.ts         # pure functions: external JSON <-> canonical Offer / Order / StockLevel
       ├── fixtures/          # recorded API responses (*.json)
       └── connector.test.ts
   ```

5. **Define `configSchema` and `credentialsSchema`.** Non-secret settings (base URL, shop id, environment) go in `configSchema`; API keys and tokens go in `credentialsSchema`. Only flat fields: string, number, boolean or enum, with `.describe('...')` for the label. Nested objects, arrays and unions fail the conformance kit because the panel cannot draw them.
6. **Write the external-response schemas** (zod) for the parts of the API you use. Parse every response; fail loudly on shape drift. No `any`.
7. **Write `mapping.ts`**: pure, synchronous, no I/O. Keep API amount strings as they are; if the API returns numbers, format them string-safely and test rounding. `placedAt` and fact `occurredAt` must be ISO datetimes with an offset or `Z`. Every line's `unitPrice.currency` equals the Order's `total.currency`. End each mapper with `offerSchema.parse(...)` / `orderSchema.parse(...)` so an invalid canonical object cannot leave the connector.
8. **Implement capabilities.** Use only `ctx.fetch`, `ctx.config`, `ctx.credentials`, `ctx.log`. Idempotent and repeatable; no module-level state. Implement only what the Channel supports (a Channel still needs the three required ones).
9. **Assemble `connector.ts`** and export it from `src/index.ts`.
10. **Record fixtures.** There is no recorder. Call the Channel's sandbox once with a throwaway script (not committed), save the response bodies as `src/fixtures/<name>.json`, then scrub tokens, real names, emails, phone numbers and addresses. Include edge cases: empty page, last page, cancelled Order, multi-line Order, an unpaid Order that must not be returned, an unknown status. If there is no sandbox, hand-write fixtures from the official docs and say so in the connector's `AGENTS.md`.
11. **Write `connector.test.ts`** (Vitest, no network):
    - call `assertConformance(connector, { config, credentials, fetch, unauthorized })` from `@hanza/connector-sdk/testing`, with a `fetch` that serves the recorded fixtures (the default `fetch` rejects, on purpose) and `unauthorized` pointing at a fixture where the API answers 401. It checks the schemas, paging and cursors, idempotent re-pulls, repeatable pushes and error classes (checks C1 to C12, see `packages/connector-sdk/src/testing/conformance.ts`);
    - add tests for what the kit cannot know: the mapper output for every fixture (amounts, currency, facts), the status mapping in both directions, the request bodies of `stock.push` and `orders.updateStatus`, and each error class from the matching HTTP status.
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

- `pnpm check:boundaries`, typecheck and tests pass, including `assertConformance`.
- Only `@hanza/connector-sdk` and `zod` in `dependencies`.
- No `process.env`, no database, no module-level state, no imports outside the SDK, no UI, no real credentials or personal data in fixtures or error messages.
- Every external response is zod-parsed; every canonical object is validated against the SDK schema.
- The connector's `AGENTS.md` documents the API's pitfalls.
