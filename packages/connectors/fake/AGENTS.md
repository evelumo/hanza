# Fake connector (`@hanza/connector-fake`)

A Channel that lives in memory. It exists to prove the whole path (pull Offers and Orders, push Available and prices, push Order status) without a real marketplace, and to give tests and demos something to talk to.

**Real connectors must never do what this one does:** it keeps data in module-level state (`fakeChannel`), reads nothing from the network, and ignores `ctx.fetch`. A real connector holds no state between calls; everything comes from the Channel's API and the cursor.

## Behaviour

- Credentials `apiKey: 'expired'` make every call fail with `AuthExpiredError`. Config `failMode` makes every call fail with `RateLimitedError` (1 s), `TransientError` or `PermanentError`.
- `offers.pull`: pages of 2, cursor = offset.
- `orders.pull`: an append-only journal; cursor = last seen journal sequence number. `addFact` re-appends the Order, so it is pulled again with the new fact; a `paid` fact also sets `awaitingPayment` to false. The seed has no unpaid Order; tests add one with `addOrder({ ..., awaitingPayment: true })`.
- `createFakeChannel({ startWithOpenOrders: true })` follows the SDK's starting rule instead: cursor `null` takes the journal position, lists the Orders open now that the journal had by then, paged by keyset (`l:<start>:<first seq of the last Order listed>`), then follows the journal from that position (`e:<start>:<seq>`). In the journal an Order the journal had by the start is sent as an Order update with its facts, never as a full Order. With it, the seed's cancelled `fake-order-2` is never imported.
- `updateOrder(id, { facts?, shippingAddress?, billingAddress? })` changes the Order and appends exactly that change as an Order update. `removeOrder(id, fact)` deletes the Order (a merged purchase): every entry of it is pulled as an update with that `cancelled` fact. `forgetJournal()` drops the journal so far: an older cursor fails with `CursorExpiredError`.
- `offers.pull` reports a PLN price on the seed Offers except `fake-offer-5`, which has none (its currency is unknown, so Hanza never pushes a price to it).
- `stock.push` and `orders.updateStatus` only record their input (`stockPushes`, `statusUpdates`; each status update is `{ orderExternalId, phase }`; the list keeps the capability's name). `price.push` records its input (`pricePushes`) and sets the Offer's price, so the next `offers.pull` reports it.

## Over HTTP (`fake-http`)

`createFakeHttpConnector()` (`src/http/`) is the same Channel seen through a small JSON API: `POST /oauth/token` (client credentials, form body) gives a Bearer token for `GET /offers`, `GET /orders`, `PUT /stock` and `PUT /orders/{id}/status`. It is a normal connector (only `ctx.fetch`, zod-parsed responses, `errorFromResponse`) and is not in the registry. It shows how a real connector is tested: its conformance test and the engine test (`apps/worker/src/recorded-fixtures.db.test.ts`) replay committed cassettes (`src/http/fixtures/`, `apps/worker/src/fixtures/`).

`@hanza/connector-fake/http-server` (test tooling, never imported by the connector) serves a fresh `createFakeChannel()` on a random local port, with a Buyer phone number, a PESEL-like id, a session cookie and the token echoed in a link, so a recording has things to scrub; `fakeHttpScrub` is the scrub config. To record again: `HANZA_RECORD_FIXTURES=1 pnpm --filter @hanza/connector-fake exec vitest run src/http/connector.test.ts` (and the same in `apps/worker` for the engine cassette, with `HANZA_TEST_DATABASE_URL` set); the recording talks only to that local server.

## Using it in tests

Create an isolated instance with `createFakeChannel()`; pass `{ id: 'fake-shop' }` (any id but `fake`) to register a second, independent fake Channel next to the first, for tests that need two Channels with their own recorded pushes; use `fakeChannel` (the instance the registry exposes) only when the registered connector itself is needed. `reset()` restores the seed and clears recorded calls. The seed data is documented in `src/seed.ts` (the code is the source of truth; the original design is GitHub issue #18).
