# Fake connector (`@hanza/connector-fake`)

A Channel that lives in memory. It exists to prove the whole path (pull Offers and Orders, push Available and prices, push Order status) without a real marketplace, and to give tests and demos something to talk to.

**Real connectors must never do what this one does:** it keeps data in module-level state (`fakeChannel`), reads nothing from the network, and ignores `ctx.fetch`. A real connector holds no state between calls; everything comes from the Channel's API and the cursor.

## Behaviour

- Credentials `apiKey: 'expired'` make every call fail with `AuthExpiredError`. Config `failMode` makes every call fail with `RateLimitedError` (1 s), `TransientError` or `PermanentError`.
- `offers.pull`: pages of 2, cursor = offset.
- `orders.pull`: an append-only journal; cursor = last seen journal sequence number. `addFact` re-appends the Order, so it is pulled again with the new fact; a `paid` fact also sets `awaitingPayment` to false. The seed has no unpaid Order; tests add one with `addOrder({ ..., awaitingPayment: true })`.
- `offers.pull` reports a PLN price on the seed Offers except `fake-offer-5`, which has none (its currency is unknown, so Hanza never pushes a price to it).
- `stock.push` and `orders.updateStatus` only record their input (`stockPushes`, `statusUpdates`). `price.push` records its input (`pricePushes`) and sets the Offer's price, so the next `offers.pull` reports it.

## The OAuth variant (`fake-oauth`)

`createFakeOAuthChannel()` (registered instance: `fakeOAuthChannel`) puts the same in-memory data (`data`, a plain fake Channel) behind an OAuth sign-in, to test the core's token handling and the panel's sign-in without a network:

- Installation settings `clientId`, `clientSecret` and `pollIntervalSeconds` (default 5) from `HANZA_CONNECTOR_FAKE_OAUTH_*`; without the first two it is "not set up".
- Credentials `{ accessToken, refreshToken, accessTokenExpiresAt }`. Every capability call checks the access token and records it in `tokenUses`; an unknown, expired or revoked one fails with `AuthExpiredError`.
- `auth.refresh` follows `options.refreshBehaviour`: `rotate` (strict rotation: the old pair stops working at once), `fail_permanent` (`AuthExpiredError`) or `fail_transient` (`TransientError`); `options.refreshDelayMs` makes concurrent refreshes overlap; every call is in `refreshes`.
- `auth.deviceFlow`: codes on `https://fake-oauth.hanza.test`; the test acts as the person with `approve(userCode, account?)`, `deny`, `slowDown`; a device code is spent after one approval.
- `issueCredentials()` makes credentials as if signed in, `expireAccessTokens()` makes the Channel refuse the tokens issued so far, `revokeAll()` also kills the refresh tokens (the seller unlinked the application).
- The e2e probe (`apps/e2e/src/fake-channel-probe.ts`) exposes approve, deny and revoke to the Playwright flows.

## Using it in tests

Create an isolated instance with `createFakeChannel()`; pass `{ id: 'fake-shop' }` (any id but `fake`) to register a second, independent fake Channel next to the first, for tests that need two Channels with their own recorded pushes; use `fakeChannel` (the instance the registry exposes) only when the registered connector itself is needed. `reset()` restores the seed and clears recorded calls. The seed data is documented in `src/seed.ts` (the code is the source of truth; the original design is GitHub issue #18).
