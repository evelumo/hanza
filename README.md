# Hanza

Open-source, self-hosted, AI-native e-commerce integration hub: an alternative to base.com / BaseLinker. Orders, stock and shipments from your marketplaces, shops and couriers, in one place.

A small, stable TypeScript core (canonical data model + background sync engine) talks to external systems through **connectors**: replaceable packages that share one layout, so a new marketplace can be added by following a single recipe (by a person or an AI agent) and checked by tests.

## Status

Early stage (stage 1 of the roadmap). Working today:

- Email/password sign-up and login (Better Auth); an organization is the tenant, created during onboarding.
- Multi-tenant data model: every tenant-owned table carries `organizationId`.
- The domain core: Products, Offers, Stock with Reservations (Hanza owns Stock), prices (a Product's base price and per-Offer overrides; Hanza owns them too), Orders with their own status, Connections with encrypted credentials, and an event log.
- The sync engine in the worker: pulls Offers and Orders from a Channel, pushes Available stock, prices and Order status back, retries and tracks Connection health.
- The panel (English by default, Polish as a second language; switch it in the header): Products (Stock, Available, prices, linking Offers to Products), Orders (status changes, Needs attention, linking Unmatched lines) and Connections (add, sync now, sync results).
- The final-for-now Connector SDK with a conformance test kit and an in-memory **fake connector** ("Test channel") that exercises the whole path without a real Channel.
- `GET /api/health` (database + queue) and a dependency-boundary check for connectors.

Not there yet: **no real connectors** (Allegro first, then WooCommerce), no REST API or MCP server, no panel E2E tests.

## Quick start

Requirements: Node.js 22+ (CI uses 24), pnpm (version pinned by `packageManager` in `package.json`; use Corepack: `corepack enable`), Docker.

```sh
cp .env.example .env          # then set BETTER_AUTH_SECRET and HANZA_ENCRYPTION_KEY (each: openssl rand -base64 32)
pnpm install
pnpm infra:up                 # Postgres on :5442, Redis on :6389
pnpm db:deploy                # apply migrations (use pnpm db:migrate while changing the schema)
pnpm dev                      # web + worker
```

Open http://localhost:3000, register and create your company. Then try the whole flow with the fake connector:

1. **Connections** > "Add connection" > "Test channel": any API key works (the key `expired` simulates a Connection that must sign in again). The worker pulls 5 Offers and 4 Orders within seconds; refresh the Connection page to see the results.
2. **Products** > "Offers without a product": select the Offers and "Create products from selected", then set Stock on a Product.
3. **Orders**: four Orders need attention (a Shortage until Stock is set; Unmatched lines to link, one of them on an Order the buyer cancelled). Link a line, then change an Order to "Shipped": Stock goes down and the new Available is pushed to the Channel.

The dashboard still has a test job that goes through the queue and worker. Stop the infrastructure with `pnpm infra:down`.

Other commands:

```sh
pnpm db:generate        # generate the Prisma client
pnpm check:boundaries   # connector dependency rules
pnpm typecheck
pnpm test
pnpm build
```

## Repo layout

```
apps/
  web/                 Next.js panel + API (Products, Orders, Connections, Better Auth routes, /api/health)
  worker/              BullMQ worker process
packages/
  core/                context, domain services, sync engine, JobQueue, job registry
  db/                  Prisma schema (split per module), migrations, client
  connector-sdk/       Connector SDK + canonical model + conformance kit
  connector-registry/  the connectors this build knows (apps pass them to the core)
  connectors/<id>/     one package per connector (only `fake` so far)
scripts/               check-boundaries.mjs
.ai/                   agent skills
docs/                  architecture plan (Polish), ADRs, agent docs
```

Stack: Next.js, Prisma + PostgreSQL, pnpm workspaces + Turborepo, BullMQ + Redis, Better Auth, zod, Vitest. No DI container; dependencies are composed in `createContext()`. Temporal is deliberately postponed.

## Roadmap

Summarised from [`docs/plan-architektury.html`](docs/plan-architektury.html) (Polish):

0. **Repo foundation**: monorepo, CI, Docker Compose, `AGENTS.md`, ADRs and glossaries, boundary lint. *(mostly done)*
1. **Core**: canonical model (Product, Variant, Offer, Order, StockLevel, Shipment, Invoice, Connection), per-table external ids (ADR 0005), event log + outbox, sync jobs (cursors, retry, rate limits, dead-letter), final Connector SDK and conformance tests.
2. **First vertical slice**: Allegro (orders in, stock out) together with WooCommerce, to validate the SDK against two channels.
3. **AI-native check**: a third connector written by an agent using the `add-connector` skill and a generator, without touching the core.
4. **Shipping and invoices**: courier labels, shipment statuses, invoicing as new capabilities.
5. **Automations + MCP + in-panel assistant**: rules ("order paid, create shipment, send invoice"), an MCP server, AI-assisted mapping.
6. **Ecosystem**: community connector registry, author docs, wholesale feeds.

## Contributing

Read [`AGENTS.md`](AGENTS.md): repo map, task router, architecture rules, and the Always / Ask first / Never lists. It is written for humans and AI agents alike. Non-trivial changes start with a spec written as a GitHub issue; decisions that are hard to reverse are recorded in [`docs/adr/`](docs/adr/). To add a connector, follow [`.ai/skills/add-connector/SKILL.md`](.ai/skills/add-connector/SKILL.md).

## License

MIT. See [`LICENSE`](LICENSE).
