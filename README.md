# Hanza

**Your commerce operations, on your infrastructure.**

An open-source, self-hosted e-commerce integration hub for Orders, Products, Stock and Connections. Hanza is building an alternative to Base.com / BaseLinker around a small TypeScript core and replaceable connectors.

[![CI](https://github.com/evelumo/hanza/actions/workflows/ci.yml/badge.svg)](https://github.com/evelumo/hanza/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Stage: early development](https://img.shields.io/badge/stage-early%20development-orange.svg)](docs/roadmap.md)

[Quick start](#quick-start) · [Try the demo](docs/demo.md) · [Documentation](docs/README.md) · [Contributing](CONTRIBUTING.md) · [Roadmap](docs/roadmap.md)

> **Early development.** The panel, domain core and worker work with a simulated Channel. There are **no real marketplace, shop or invoicing connectors yet**, and the one real courier connector (InPost) has run against InPost's sandbox only: a locker shipment was created, bought and labelled there, while the courier service, cash on delivery and anything after the label are not proven on a live account yet. Use Hanza to evaluate the architecture, try the demo and contribute; connecting a live business is a future milestone.

## Why Hanza?

Commerce operations need a consistent view of what was sold, what is still available and what needs a person's attention. Hanza puts those rules in one core and keeps each external system behind a connector.

- **Own your installation.** Run the panel, worker and data stores yourself; the repository is MIT licensed.
- **One authority for Stock and prices.** Hanza sends them to Channels. Reservations and fulfilment use the same domain rules across connectors.
- **Extend through a defined contract.** Connectors translate a Channel's API into the canonical model, without accessing the database or importing the core. A conformance kit checks their behaviour.
- **Build with humans and AI agents.** Task routing, domain glossaries, ADRs, specs and a connector skill give contributors explicit conventions to follow.

“AI-native” currently describes the development approach. An in-panel AI assistant, an MCP server and AI-assisted mapping are **planned**. Running Hanza today requires no AI provider account or model key.

## What works today

| Area | Available in this repository |
| --- | --- |
| Panel | English and Polish; dashboard, Products, Product families, Orders, Warehouses, Connections, Privacy and Settings |
| Catalogue | Products with fixed SKUs, Product families, Offer linking, base prices and per-Offer overrides |
| Stock | Stock per Warehouse, Reservations, Shortages, Channel warehouse selection, safety buffers and channel limits |
| Orders | Order feed, Unmatched lines, Needs attention, four fixed Order phases and organization-defined Order statuses |
| Connections | Encrypted credentials, background synchronisation, Connection health, sync results and per-Offer push rejections |
| Shipments | A Shipment from an Order through a courier Connection: Label download, status tracking, cancelling, and a carrier pickup that ships the Order |
| Buyer data | Sealed Buyer snapshots, retention periods and erasure requests for Closed Orders |
| Runtime | Separate worker, retries, shared request limits and durable workflows with Postgres state, timers and signals |
| Connector development | SDK, conformance kit, scrubbed HTTP recordings and simulated connectors |
| Quality | Dependency boundary checks, type checks, Vitest tests and local Playwright panel flows |

The current connectors are **Test channel** (`fake`) and **Test OAuth channel** (`fake-oauth`, requires demo installation settings), which simulate a Channel, **Test courier** (`fake-courier`), which simulates a Carrier, and **InPost** (`inpost`), the first real one. The HTTP reference implementations are tested on recordings and are not registered in the panel. See the [connector catalogue and author guide](packages/connectors/README.md).

## Quick start

Requirements: **Node.js 22+** (CI uses 24), **pnpm 10.34.6** (pinned in `package.json`), Docker with Compose, and OpenSSL to generate local secrets.

```sh
git clone https://github.com/evelumo/hanza.git
cd hanza
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
```

Generate **two separate values**, then paste one into `BETTER_AUTH_SECRET` and the other into `HANZA_ENCRYPTION_KEY` in `.env`:

```sh
openssl rand -base64 32
openssl rand -base64 32
```

Then start the local installation:

```sh
pnpm infra:up
pnpm db:generate
pnpm db:deploy
pnpm dev
```

Open **http://localhost:3000**, sign up and create your company. Postgres uses port **5442** and Redis **6389**; the Compose file starts those two services, while `pnpm dev` starts the web app and worker.

Try [the demo](docs/demo.md): add a Test channel, import five Offers and four Orders, create Products from Offers, set Stock and fulfil an Order. No external account is needed.

For configuration, health checks and troubleshooting, read the [full quick start](docs/quick-start.md). For operating an installation, read [self-hosting](docs/self-hosting.md).

## Architecture

```text
Browser → Next.js panel → Core services → PostgreSQL
                              │
                           JobQueue
                              │
                            Redis
                              │
                         Worker → Connector → Channel API
```

The apps compose dependencies with `createContext()` and supply connectors from a separate registry. The core owns domain rules and persistence; connectors depend only on the Connector SDK and zod. Long-running work runs in the worker.

| Workspace | Responsibility |
| --- | --- |
| [`apps/web`](apps/web/README.md) | Next.js panel, Better Auth routes, health endpoint and translations |
| [`apps/worker`](apps/worker/README.md) | Background jobs, sync, workflow execution and privacy scheduling |
| [`apps/e2e`](apps/e2e/README.md) | Playwright panel flows and an isolated local runner |
| [`packages/core`](packages/core/README.md) | Domain services, context, sync, workflows, queue and request limits |
| [`packages/db`](packages/db/README.md) | Prisma schema, migrations and client |
| [`packages/connector-sdk`](packages/connector-sdk/README.md) | Connector contract, canonical schemas and conformance tests |
| [`packages/connector-registry`](packages/connector-registry/README.md) | Connectors included in this build |
| [`packages/connectors`](packages/connectors/README.md) | Connector implementations and recorded-fixture guide |

Stack: Next.js + React, TypeScript, Prisma + PostgreSQL, BullMQ + Redis, Better Auth, zod, pnpm + Turborepo, Vitest and Playwright. See [architecture](docs/architecture.md), [domain vocabulary](CONTEXT-MAP.md) and [ADRs](docs/adr/).

## Contribute

Documentation fixes, reproducible bug reports, tests and connectors that fit the current SDK are useful starting points. Larger changes start with a reviewed GitHub issue; the core contracts and Stock rules have explicit review gates.

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md), then choose an [issue](https://github.com/evelumo/hanza/issues). AI-assisted contributions follow the same rules and validation gate.

```sh
pnpm typecheck
pnpm test
```

Database tests need `HANZA_TEST_DATABASE_URL`; Redis tests need a reachable Redis. Browser flows run separately with `pnpm test:e2e` and are not in CI yet. The [testing guide](docs/testing.md) explains coverage, prerequisites and skipped runs.

## Direction and community

The next product milestone is a real Order-and-Stock flow with Allegro and WooCommerce. More Carriers, invoicing, automations and product-facing AI follow later. The [roadmap](docs/roadmap.md) distinguishes implemented foundations from planned work and links to the original Polish architecture plan.

Use [GitHub Issues](https://github.com/evelumo/hanza/issues) for bugs, questions and proposals. Read [SUPPORT.md](SUPPORT.md) for reporting guidance and [SECURITY.md](SECURITY.md) for private vulnerability reports.

Hanza is an independent project. [Open Mercato](https://github.com/open-mercato/open-mercato) is an inspiration for explicit architecture conventions and development with AI agents.

## License

[MIT](LICENSE) — copyright © 2026 Hanza contributors.
