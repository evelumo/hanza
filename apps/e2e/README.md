# @hanza/e2e

Local Playwright flows against a real Hanza web app and worker, using simulated Channels. These flows are separate from `pnpm test` and are not currently run in CI.

## Run

Set up local Postgres/Redis and the root `.env` using [the quick start](../../docs/quick-start.md). Set `HANZA_TEST_DATABASE_URL` to a local server where tests may create/drop databases, then:

```sh
pnpm --filter @hanza/e2e exec playwright install chromium
pnpm test:e2e
pnpm test:e2e --grep stock
```

Run these commands from the repository root. Missing test database configuration or Chromium causes a **skip with exit 0**, not a browser pass.

## Isolation and evidence

`src/run.ts` creates a throwaway database, Redis queue prefix and free ports per run. It builds/starts the app and worker, then runs `flows/*.spec.ts`. It deletes only its own resources, not the development database or all Redis keys. Redis is restricted to loopback unless explicitly opted in.

On failure/interruption, evidence stays in `results/<run id>/`: web/worker `logs/`, `test-results/` traces and `report/`. Successful runs delete their results directory. The runner handles process/resource cleanup and the next run recovers provably dead runs left by a hard crash. Full details: [AGENTS.md](../../AGENTS.md#panel-end-to-end-flows).

## Add a flow

Import `test` and `expect` from `../src/fixtures`, not directly from Playwright. Begin each test with its own `signUp`; use `addFakeConnection`, `waitForSeedOrders` and `reloadUntil` as appropriate.

Locate by roles and accessible names in English. Wait for page headings after navigation and for observable background results; never add fixed sleeps or `data-testid`. The shell repeats names, so scope them: destinations through `mainNavigation(page)` or `navLink(page, name)` (the breadcrumb links to a list by the same name, and "Orders" and "Offers" carry a count in their name once something waits), a form's `status` or `alert` inside its region or row (a loading route shows a `status` of its own). `openCommandPalette(page)` opens the command palette; `orderPrimaryAction(page, name)` is the header button that moves an Order on to its next phase; `openUserMenu(page, account)` gives the menu with the language, the theme and "Sign out"; `confirmation(page, name)` is the alert dialog that replaces `window.confirm`, named after the pressed button. Use the `fakeChannel` fixture to inspect calls since your action, and scope any `db` fixture queries by organization.

Run the suite three times before opening a PR after a panel/flow change. The workspace also has Vitest tests for runner helpers; these do not start a browser. See [the testing guide](../../docs/testing.md).
