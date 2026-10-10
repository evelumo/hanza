# @hanza/core

Hanza's domain services and background execution machinery. Apps supply connector definitions to `createContext()`; the core never imports a connector implementation or the build-time registry.

## Responsibilities

- Environment validation, explicit context composition, logging and secrets.
- Catalogue, Stock/Reservations, Orders, Order statuses, Warehouses, Connections, Shipments and privacy services.
- Sync orchestration, registered jobs, queue abstraction and Connection health.
- Durable workflows with PostgreSQL state, timers/signals and queue-driven steps.
- Connector request limits shared across workers through Redis.

Public workspace exports come from `src/index.ts`; test helpers are available at `@hanza/core/testing`. The package ships TypeScript source and has no separate build step.

## Boundaries

The core depends on `@hanza/db` and `@hanza/connector-sdk`. It owns persistence and domain invariants; connectors translate external APIs. Callers use `JobQueue`, `ctx.workflows` and `ctx.rateLimiter`, rather than directly using BullMQ or Redis.

Tenant service operations use `organizationId`; jobs validate it in their payload. Buyer data is written/read through the privacy services. Stock, sync and contract changes require the reviewed spec/approval process in [AGENTS.md](../../AGENTS.md).

See [the Core glossary](CONTEXT.md), [architecture](../../docs/architecture.md) and [ADRs](../../docs/adr/). Run `pnpm typecheck` and `pnpm test` from the root; database/Redis test prerequisites are described in [testing](../../docs/testing.md).
