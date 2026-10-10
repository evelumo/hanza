# @hanza/web

The Next.js App Router panel and HTTP entry points for Hanza. It serves Products, Product families, Orders, Warehouses, Connections, Privacy, Settings and the dashboard, with Better Auth for authentication and organization onboarding.

## Run

Follow the [root quick start](../../docs/quick-start.md). `pnpm dev` starts web and worker together. After `pnpm build`, run the web process with:

```sh
pnpm --filter @hanza/web start
```

Run the worker separately for background results. The root `.env` is loaded by `next.config.ts`.

## Layout and contracts

- `src/app/(auth)`: public authentication/onboarding pages.
- `src/app/(panel)`: authenticated panel pages and actions.
- `src/app/api/auth`: Better Auth routes; `/api/health` checks database and queue connectivity.
- `src/lib`: session, context, validation, domain-error and formatting helpers.
- `src/components`: the panel's kit on shadcn/ui (page header, sections, tables, forms, badges), with the shadcn primitives in `ui/` and the app shell in `shell/`; the theme tokens are in `src/app/globals.css`.
- `messages/{en,pl}.json` and `src/i18n` provide translations.

Start tenant operations with `requireTenant()` and use its `organizationId` for every query. Get dependencies from `getContext()`, validate boundary input with zod and return localized expected errors. Locale comes from the `hanza_locale` cookie, then `Accept-Language`, without a URL prefix. New copy goes into both catalogues; the English keys are the source of truth.

Vitest covers pure helpers, not rendered browser interactions. Panel flows live in [`apps/e2e`](../e2e/README.md). See [the package agent guide](AGENTS.md), [development](../../docs/development.md) and [testing](../../docs/testing.md).
