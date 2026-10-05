# Fake connector (`@hanza/connector-fake`)

A Channel that lives in memory. It exists to prove the whole path (pull Offers and Orders, push Available, push Order status) without a real marketplace, and to give tests and demos something to talk to.

**Real connectors must never do what this one does:** it keeps data in module-level state (`fakeChannel`), reads nothing from the network, and ignores `ctx.fetch`. A real connector holds no state between calls; everything comes from the Channel's API and the cursor.

## Behaviour

- Credentials `apiKey: 'expired'` make every call fail with `AuthExpiredError`. Config `failMode` makes every call fail with `RateLimitedError` (1 s), `TransientError` or `PermanentError`.
- `offers.pull`: pages of 2, cursor = offset.
- `orders.pull`: an append-only journal; cursor = last seen journal sequence number. `addFact` re-appends the Order, so it is pulled again with the new fact.
- `stock.push` and `orders.updateStatus` only record their input (`stockPushes`, `statusUpdates`).

## Using it in tests

Create an isolated instance with `createFakeChannel()`; use `fakeChannel` (the instance the registry exposes) only when the registered connector itself is needed. `reset()` restores the seed and clears recorded calls. The seed data is documented in `src/seed.ts` and in the stage 1 spec (`.ai/specs/2026-10-04-stage-1-core.md`, section 5.6).
