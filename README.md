# Hanza

Open-source, self-hosted, AI-native e-commerce integration hub: an alternative to base.com / BaseLinker. Orders, stock and shipments from your marketplaces, shops and couriers, in one place.

A small, stable TypeScript core (canonical data model + background sync engine) talks to external systems through **connectors**: replaceable packages that share one layout, so a new marketplace can be added by following a single recipe (by a person or an AI agent) and checked by tests.

## Status

Early scaffold. Working today:

- Email/password sign-up and login (Better Auth); an organization is the tenant, created during onboarding.
- Multi-tenant data model: every tenant-owned table carries `organizationId`.
- The queue pipeline end to end: panel → `JobQueue` (BullMQ + Redis) → separate worker → PostgreSQL. The dashboard has a test job that writes to the event log.
- `GET /api/health` (database + queue).
- A draft Connector SDK (`defineConnector`, `orders.pull`, `stock.push`, draft `Order` / `StockLevel` schemas) and a dependency-boundary check for connectors.

Not there yet: **no connectors** (Allegro first, then WooCommerce), no products/orders/stock tables, no sync engine, no REST API or MCP server, no panel E2E tests.

## Quick start

Requirements: Node.js 22+ (CI uses 24), pnpm (version pinned by `packageManager` in `package.json`; use Corepack: `corepack enable`), Docker.

```sh
cp .env.example .env          # then set BETTER_AUTH_SECRET (e.g. openssl rand -base64 32)
pnpm install
pnpm infra:up                 # Postgres on :5442, Redis on :6389
pnpm db:deploy                # apply migrations (use pnpm db:migrate while changing the schema)
pnpm dev                      # web + worker
```

Open http://localhost:3000, register, create your company, and press "Wyślij zadanie testowe" on the dashboard: the job goes through the queue and worker and shows up in the event list. Stop the infrastructure with `pnpm infra:down`.

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
  web/                 Next.js panel + API (Better Auth routes, /api/health)
  worker/              BullMQ worker process
packages/
  core/                context, env, logger, JobQueue, job registry
  db/                  Prisma schema (split per module), migrations, client
  connector-sdk/       Connector SDK + canonical model (draft)
  connectors/<id>/     one package per connector (none yet)
scripts/               check-boundaries.mjs
.ai/                   specs and agent skills
docs/                  architecture plan (Polish)
```

Stack: Next.js, Prisma + PostgreSQL, pnpm workspaces + Turborepo, BullMQ + Redis, Better Auth, zod, Vitest. No DI container; dependencies are composed in `createContext()`. Temporal is deliberately postponed.

## Roadmap

Summarised from [`docs/plan-architektury.html`](docs/plan-architektury.html) (Polish):

0. **Repo foundation**: monorepo, CI, Docker Compose, `AGENTS.md`, spec template, boundary lint. *(mostly done)*
1. **Core**: canonical model (Product, Variant, Offer, Order, StockLevel, Shipment, Invoice, Connection), `external_ref` mapping, event log + outbox, sync jobs (cursors, retry, rate limits, dead-letter), final Connector SDK and conformance tests.
2. **First vertical slice**: Allegro (orders in, stock out) together with WooCommerce, to validate the SDK against two channels.
3. **AI-native check**: a third connector written by an agent using the `add-connector` skill and a generator, without touching the core.
4. **Shipping and invoices**: courier labels, shipment statuses, invoicing as new capabilities.
5. **Automations + MCP + in-panel assistant**: rules ("order paid, create shipment, send invoice"), an MCP server, AI-assisted mapping.
6. **Ecosystem**: community connector registry, author docs, wholesale feeds.

## Contributing

Read [`AGENTS.md`](AGENTS.md): repo map, task router, architecture rules, and the Always / Ask first / Never lists. It is written for humans and AI agents alike. Non-trivial changes start with a spec in [`.ai/specs/`](.ai/specs/README.md). To add a connector, follow [`.ai/skills/add-connector/SKILL.md`](.ai/skills/add-connector/SKILL.md).

## License

MIT. See [`LICENSE`](LICENSE).
