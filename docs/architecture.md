# Architecture

Hanza separates commerce rules from external APIs. The current runtime consists of a Next.js web app, a separate worker, PostgreSQL and Redis. The apps supply connector definitions to the core through a registry.

## Dependency direction

```text
apps/web ─────┬──→ @hanza/core ──→ @hanza/db
apps/worker ──┘         └───────→ @hanza/connector-sdk

apps/web ─────┬──→ @hanza/connector-registry
apps/worker ──┘               └──→ connectors ──→ @hanza/connector-sdk
```

Connectors may depend only on the SDK and zod. The core, SDK and database do not import connectors or the registry. Apps may use lower-level workspace exports where needed, but packages never import apps. [`scripts/check-boundaries.mjs`](../scripts/check-boundaries.mjs) enforces connector dependency rules.

Dependencies are composed explicitly in [`createContext()`](../packages/core/src/context.ts): database, logger, secrets, queue, connector registry, workflow engine and rate limiter. There is no DI container.

## Data ownership

| Concept | Rule |
| --- | --- |
| Organization | The tenant; panel identity comes from the authenticated session |
| Product | A sellable item with a fixed SKU; a Product family groups related Products |
| Offer | A Product's representation on a Channel; may remain unlinked until matched |
| Stock | Owned by Hanza, stored per Warehouse; Channels receive computed Channel Available |
| Price | Owned by Hanza; base prices and per-Offer overrides use decimal strings and ISO currency |
| Order phase | Fixed `new`, `processing`, `shipped`, `cancelled`; drives domain and connector behaviour |
| Order status | An organization's label within a phase; same-phase changes do not affect Stock or Channels |
| Buyer data | Snapshot on an Order, sealed in the core and read through privacy services |
| Connection | An organization's authorized account through a connector, with sealed credentials |
| Event | A record committed with a domain change; state tables remain the source of truth |

The [context map](../CONTEXT-MAP.md) links the full glossaries. Use their terms when changing code, tests and copy.

## Request and background execution

A panel page, API route or server action begins with `requireTenant()`. Input is validated with zod and domain queries use the returned `organizationId`. Domain services commit state and Events; work is requested through `JobQueue`.

The worker executes registered jobs, pulls Offers and the Order feed, and pushes Stock, prices and supported Order phase changes. Connector requests go through a shared rate limiter and timeout-aware `ctx.fetch`. Credentials are decrypted by the core and supplied to the connector; the connector adds its own request authentication.

Jobs must be idempotent because queue retries can repeat execution. Work enqueued after a database commit is best-effort; specific schedulers/sweeps recover due work. This is not a generic transactional outbox guarantee. See [ADR 0010](adr/0010-work-after-commit-is-best-effort.md).

The web app's health endpoint checks the database and queue connection. Worker output and completed job/sync results are separate evidence of background progress.

## Durable workflows

`defineWorkflow` declares named steps, sleeps and waits for signals. `ctx.workflows` manages tenant-scoped runs. PostgreSQL stores durable state and signals; queue jobs execute steps and a sweep recovers due runs.

Steps are **at-least-once**, with a ten-minute lease and no heartbeat yet. Keep steps short and make effects idempotent. Inputs, results and signal payloads must be JSON and no larger than 256 KB; store references rather than Buyer data. Temporal is a possible future engine behind the interface, not a current dependency. See [ADR 0014](adr/0014-workflows-run-on-postgres-state-and-the-job-queue.md).

## Tenant isolation and Buyer data

Tenant-owned records carry `organizationId`. Panel operations derive it from the session; jobs carry it in validated payloads. Composite keys protect selected cross-record relationships. Global schedulers have narrowly defined cross-organization reads; they do not authorize panel access across tenants.

Buyer data is sealed with AES-256-GCM, bound to its organization/Connection/Order. A Shipment's Label and the destination a person confirmed for it are Buyer data as well, sealed and bound to the organization and the Shipment ([ADR 0023](adr/0023-a-shipment-row-is-its-own-request-and-its-label-is-fetched-by-the-worker-and-sealed.md)). Privacy services handle read access, retention and erasure of Closed Orders. Credentials use the same installation key. Keep the key with backups: replacing it makes existing sealed values unreadable. Encryption-key rotation is not implemented. See [ADR 0016](adr/0016-buyer-data-is-sealed-and-erased-in-place.md).

## Decisions to read first

- [0001: Hanza owns Stock](adr/0001-hanza-owns-stock.md)
- [0003: Order transitions and Channel facts](adr/0003-order-status-is-owned-by-hanza.md)
- [0007: Separate connector registry](adr/0007-connector-registry-is-a-separate-package.md)
- [0017: Warehouses and placement](adr/0017-channel-warehouses-and-placement.md)
- [0018: Order statuses within phases](adr/0018-order-statuses-are-labels-within-fixed-phases.md)
- [0019: Shared connector request limits](adr/0019-connectors-declare-rate-limits-the-core-enforces-them-in-redis.md)
- [0020: Core-owned token lifetime](adr/0020-the-core-owns-token-lifetime.md)
- [0021: Order feed starts with open Orders](adr/0021-an-order-feed-starts-with-the-orders-open-now.md)
- [0023: A Shipment row is its own request](adr/0023-a-shipment-row-is-its-own-request-and-its-label-is-fetched-by-the-worker-and-sealed.md)
- [0024: A carrier pickup ships the Order](adr/0024-a-carrier-pickup-ships-the-order.md)

Read the [roadmap](roadmap.md) before treating the Polish architecture plan's public APIs, automations or AI tools as implemented features.
