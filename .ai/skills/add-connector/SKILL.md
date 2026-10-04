---
name: add-connector
description: Add a new marketplace, shop, courier or invoicing connector to Hanza as a package under packages/connectors/<id> against the current draft Connector SDK. Use when asked to "add a connector", integrate an external API (Allegro, WooCommerce, ...), or write orders.pull / stock.push for a channel.
---

# Add a connector

> **The SDK is a draft.** `@hanza/connector-sdk` will be finalised in stage 1 of the roadmap (canonical model, `defineCapability`, conformance test kit). Expect breaking changes. This skill describes what works **today**.
>
> **Not supported yet** (do not invent them): `pnpm create-connector` generator, `pnpm generate` auto-discovery/registry, `pnpm test:connector <id>` and the shared conformance test kit, capabilities other than `orders.pull` and `stock.push` (no offers, shipments, invoices, webhooks/notifications), a recording tool for fixtures, secret storage / OAuth flows in the core, and loading a connector from the panel. A connector written now is a standalone package validated by its own tests; wiring it into the core is later work and needs a spec.

## Rules

- A connector depends **only** on `@hanza/connector-sdk` and `zod` (`pnpm check:boundaries` fails otherwise). Never import `@hanza/db`, `@hanza/core`, another connector, or `apps/*`.
- No UI, no database access. The panel draws the connection form from the connector's `configSchema`; the core owns persistence, cursors, retries, rate limits and secrets.
- External API JSON is parsed with zod and mapped by pure functions into the canonical `Order` / `StockLevel`. Money is a decimal string (`"129.99"`) plus ISO currency, never a float.
- **If you need to change the SDK or the core to finish, stop and write a spec** (`.ai/specs/TEMPLATE.md`) instead of editing them. That includes the canonical model.
- Tests are deterministic: recorded fixtures, no network, no real accounts or keys.

## The draft SDK (read the source: `packages/connector-sdk/src`)

```ts
// connector.ts
export interface CapabilityContext<TConfig> {
  config: TConfig                          // validated against configSchema
  fetch: typeof fetch                      // authenticated HTTP client supplied by the core
  log(message: string, fields?: Record<string, unknown>): void
}
export interface PullResult<T> { items: T[]; nextCursor: string | null }  // cursor is opaque; the core stores it per connection
export interface Capabilities<TConfig> {
  'orders.pull'?: (ctx: CapabilityContext<TConfig>, cursor: string | null) => Promise<PullResult<Order>>
  'stock.push'?: (ctx: CapabilityContext<TConfig>, levels: StockLevel[]) => Promise<void>
}
export interface ConnectorDefinition<TConfigSchema extends z.ZodType = z.ZodType> {
  id: string                               // /^[a-z][a-z0-9-]*$/, e.g. "allegro"
  name: string
  kind: 'marketplace' | 'shop' | 'courier' | 'invoicing'
  auth: { type: 'oauth2' } | { type: 'apiKey' }
  configSchema: TConfigSchema
  capabilities: Capabilities<z.infer<TConfigSchema>>
}
export function defineConnector<T extends z.ZodType>(definition: ConnectorDefinition<T>): ConnectorDefinition<T>  // throws on a bad id
export function listCapabilities(connector: ConnectorDefinition): CapabilityName[]
```

```ts
// model/order.ts (DRAFT)
moneySchema      = { amount: string /^-?\d+(\.\d+)?$/, currency: string(3) }
orderLineSchema  = { externalId, sku: string | null, name, quantity: int > 0, unitPrice: Money }
orderSchema      = { externalId, status: 'new' | 'paid' | 'processing' | 'shipped' | 'cancelled',
                     placedAt: ISO datetime, total: Money, lines: OrderLine[] (min 1) }
// model/stock.ts (DRAFT)
stockLevelSchema = { sku: string, available: int >= 0 }
```

Everything above is exported from `@hanza/connector-sdk` (`defineConnector`, `listCapabilities`, the types, `moneySchema`, `orderLineSchema`, `orderSchema`, `stockLevelSchema`).

## Procedure

1. **Check scope.** Read `AGENTS.md` and `packages/connectors/README.md`. Confirm the channel's API can be expressed with `orders.pull` and/or `stock.push` and the draft `Order` fields. If it needs something the canonical model lacks (shipping address, buyer, tax, variants, ...), stop and write a spec.
2. **Pick the id.** Lowercase slug (`allegro`, `woocommerce`). Package name `@hanza/connector-<id>`, directory `packages/connectors/<id>/`.
3. **Create the package.** `package.json`:

   ```json
   {
     "name": "@hanza/connector-<id>",
     "version": "0.0.0",
     "private": true,
     "type": "module",
     "exports": { ".": "./src/index.ts" },
     "scripts": { "typecheck": "tsc --noEmit", "test": "vitest run" },
     "dependencies": { "@hanza/connector-sdk": "workspace:*", "zod": "^4.6.5" },
     "devDependencies": { "typescript": "^6.0.3", "vitest": "^5.0.3" }
   }
   ```

   Only `dependencies` are checked by `pnpm check:boundaries`; keep `devDependencies` to `typescript` and `vitest` (match the versions in `packages/connector-sdk/package.json`). `tsconfig.json` (same as the SDK; `DOM` lib gives the `fetch` types):

   ```json
   { "extends": "../../../tsconfig.base.json", "compilerOptions": { "lib": ["ES2023", "DOM"] }, "include": ["src"] }
   ```

   Run `pnpm install` once so the workspace link is created (`pnpm-workspace.yaml` already includes `packages/connectors/*`).
4. **Lay out the sources.** Target layout from the plan, adapted to the draft SDK. Files marked * are the only ones that exist as a concept today; the rest are optional structure that stays internal to your package. Keep sources under `src/` like every other package here.

   ```
   packages/connectors/<id>/
   ├── package.json  tsconfig.json
   ├── AGENTS.md              # API-specific pitfalls: quirks, rate limits, pagination, sandbox notes
   └── src/
       ├── index.ts           # re-exports the connector
       ├── connector.ts *     # defineConnector({ id, name, kind, auth, configSchema, capabilities })
       ├── auth.ts            # only the declaration/config shape; secrets and token refresh belong to the core (not built yet)
       ├── client.ts          # thin helpers over ctx.fetch: URL building, zod-parsed responses, error mapping
       ├── capabilities/      # orders-pull.ts, stock-push.ts: one file per capability
       ├── mapping.ts *       # pure functions: external JSON <-> canonical Order / StockLevel
       ├── fixtures/          # recorded API responses (*.json)
       └── connector.test.ts *
   ```

5. **Define `configSchema`** with zod: everything a user must enter (base URL, shop id, environment). Do not put client secrets or tokens in it unless the API key *is* the connection credential (`auth: { type: 'apiKey' }`); then keep it a plain string field and never log it.
6. **Write the external-response schemas** (zod) for the parts of the API you use, in `client.ts` or next to the mapper. Parse every response; fail loudly on shape drift. Do not use `any`.
7. **Write `mapping.ts`**: pure, synchronous, no I/O. Map external status values to the canonical status enum (document the table in a comment only if non-obvious); convert amounts to decimal strings without float math (keep API strings as they are; if the API returns numbers, format with a string-safe approach and test rounding); `placedAt` must be an ISO datetime with offset/`Z`. End each mapper with `orderSchema.parse(...)` so an invalid canonical object cannot leave the connector.
8. **Implement capabilities** against `CapabilityContext`:
   - `orders.pull(ctx, cursor)`: fetch one page starting from `cursor` (`null` = from the beginning), return `{ items, nextCursor }`; `nextCursor: null` means "caught up". Idempotent: the same cursor must yield the same page. Use only `ctx.fetch`, `ctx.config`, `ctx.log`. Never read `process.env` or hold module-level state.
   - `stock.push(ctx, levels)`: send `{ sku, available }` to the channel; resolve on success, throw on failure so the core can retry. Treat the call as repeatable.
   - Implement only what the channel supports; omit the rest (`listCapabilities` reports exactly what is present).
9. **Assemble `connector.ts`** with `defineConnector({ ... })` and export it from `src/index.ts`.
10. **Record fixtures.** There is no recorder yet. Call the channel's sandbox/test environment once with a throwaway local script (not committed), save the response bodies as `src/fixtures/<name>.json`, then scrub tokens, real names, emails, phone numbers and addresses. Include edge cases: empty page, last page, cancelled order, multi-line order, an unknown status. Never commit credentials or real customer data. If there is no sandbox, hand-write fixtures from the official API docs and say so in the connector's `AGENTS.md`.
11. **Write `connector.test.ts`** (Vitest). Build a fake context: `{ config, log: () => {}, fetch: async (url) => new Response(JSON.stringify(fixture)) }`, and assert:
    - `listCapabilities(connector)` equals what you implemented;
    - mapper output passes `orderSchema` for every order fixture, with correct amounts/currency/status;
    - `orders.pull` returns the expected `nextCursor` across pages and passes the cursor to the request;
    - `stock.push` sends the expected request body and throws on a non-2xx response;
    - bad config is rejected by `configSchema`.
12. **Validate** (run what you can; report what you could not):

    ```sh
    pnpm check:boundaries
    pnpm --filter @hanza/connector-<id> typecheck
    pnpm --filter @hanza/connector-<id> test
    pnpm typecheck && pnpm test      # whole repo, to be sure nothing else broke
    ```

13. **Write the connector's `AGENTS.md`**: auth flow, rate limits, pagination/cursor semantics, status mapping, sandbox URL, known API quirks, how fixtures were recorded.
14. **Report**: files created, capabilities implemented, anything the draft SDK could not express (list it as input for the stage 1 spec; do not work around it by touching the SDK or core).

## Definition of done

- `pnpm check:boundaries`, typecheck and tests pass.
- Only `@hanza/connector-sdk` and `zod` in `dependencies`.
- No `process.env`, no database, no imports outside the SDK, no UI, no real credentials or personal data in fixtures.
- Every external response is zod-parsed; every canonical object is validated against the SDK schema.
- The connector's `AGENTS.md` documents the API's pitfalls.
