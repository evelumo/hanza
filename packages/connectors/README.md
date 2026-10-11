# Connectors

One directory per connector, each its own package (`@hanza/connector-<id>`).

For an overview of the product, start with the [project README](../../README.md).
To try a connector in the panel, follow the [demo walkthrough](../../docs/demo.md).
Authors should read [CONTRIBUTING.md](../../CONTRIBUTING.md), the SDK's
[README](../connector-sdk/README.md) and [Commerce model glossary](../connector-sdk/CONTEXT.md),
then follow the [add-connector skill](../../.ai/skills/add-connector/SKILL.md).
The [fake package README](fake/README.md) introduces the reference implementations below.

A connector may depend only on `@hanza/connector-sdk` and `zod` —
`pnpm check:boundaries` enforces it. It has no UI, never touches the database,
and never imports the core or another connector. Layout and rules: see
`AGENTS.md` at the repo root and `.ai/skills/add-connector/SKILL.md`. A connector that needs an SDK or core change starts with a spec, which is a GitHub issue (see "Specs, decisions and vocabulary" in `AGENTS.md`).

Connectors speak **Order phases** (`new`, `processing`, `shipped`, `cancelled`), never an
organization's own Order statuses: they translate Channel statuses to and from phases in
code, and the core decides which Order status an Order gets (ADR 0018).

`orders.pull` returns Orders ready to fulfil. A connector may also return
Orders the Buyer has not paid for yet, with `awaitingPayment: true`, if it adds
a `paid` Channel fact once they are paid (ADR 0015; details in the skill):

- Synthesize the `paid` fact from the snapshot's payment status, with a stable
  id (for example `${orderId}:paid`) and `occurredAt` = the payment time.
  Dropping `awaitingPayment` without it leaves the Order awaiting payment.
- Once a `paid` fact exists, never set `awaitingPayment` back to true (chargeback,
  refund): one Order that breaks `orderSchema` turns the whole page into a
  `PermanentError` and stops the Connection's Order feed.

A connector that needs settings of the whole installation (an OAuth
application's client id and secret) declares `appConfigSchema`; the core reads
them from `HANZA_CONNECTOR_<ID>_<FIELD>` and passes them as `ctx.app`. A
connector with `auth.type: 'oauth2'` may add `auth.refresh` and
`auth.expiresAt` (the core decides when to refresh and stores the rotated
credentials, ADR 0020) and `auth.deviceFlow` (the panel's "Connect" and "Sign
in again" then go through a code the person approves on the Channel). Its
credentials are never typed into a form.

Only an explicit auth signal asks a person to sign in again: a 401, a
`WWW-Authenticate: Bearer error="invalid_token"`, or the connector's own
`isAuthFailure` predicate passed to `errorFromResponse`. A 403 means "no right to
this resource" and fails the run as permanent, without a sign-in prompt
(conformance check C14).

A connector declares its Channel's request limits in `rateLimits` (per API
application, per Connection, concurrency); the core enforces them in `ctx.fetch`
across every worker (ADR 0019). `ctx.fetch` may then reject with
`RateLimitedError` before sending: let it through unchanged.

Where `orders.pull` starts and what it may return (ADR 0021; details in the skill):

- Cursor `null` takes the feed's start (journal position and a boundary
  between Orders placed before and after it), returns the Orders open on the
  Channel now, paged by keyset (never a plain offset), then follows the journal
  from that position. In the journal a full Order is sent only for an Order
  placed after the boundary; any other Order goes as an Order update, so Orders
  closed before the Connection never arrive. The cursor is opaque: encode the
  phase, position and boundary in it, for ever.
- When the Channel no longer has the cursor's position, throw
  `CursorExpiredError`: the core restarts from `null` and records it.
- An item is a full Order or an Order update (`kind: 'update'`: facts and
  addresses), for what the Channel cannot serve as a whole Order (an address
  revealed at payment, an Order that disappeared). The core ignores updates
  for Orders it does not have.

Every connector proves it follows the contract with the conformance kit,
called from its own `connector.test.ts` with recorded fixtures and no network
(see "Recorded fixtures" below).

A Channel must implement `offers.pull`, `orders.pull` and `stock.push`;
`price.push` and `orders.updateStatus` are optional. Hanza owns prices
(ADR 0011): `offers.pull` reports each Offer's current `price` so Hanza knows
the Channel's currency, and `price.push` sets the price Hanza sends, always in
that currency. Report that price as the canonical `Money`: a decimal string
with at most 4 decimal places and an upper-case ISO 4217 currency (`PLN`, not
`pln` or `zł`). Like any other field, a value that breaks the SDK schema fails
the whole `offers.pull` page, not just that Offer; if the Channel's price does
not fit, report `price: null`.

Report each Offer's publication too when the Channel has one (`status`:
`active`, `inactive` or `ended`, and for `ended` the `endedReason`: `sold_out`
when the Channel ended it because its stock reached 0, `other` otherwise), and
keep returning ended Offers: they stay linked. `stock.push` and `price.push` may
return a result per Offer instead of failing the call for one Offer the Channel
refuses: `{ offerExternalId, outcome: 'rejected', code }` with the Channel's
short error code (letters, digits and `_ . : -`; never free text, which may
echo data), and for stock `outcome: 'ended'` for every 0 that leaves the Offer
sold out, also when it already was (a push retried after a lost answer must
still tell Hanza). Offers left out count as applied; throw only when the whole
call failed. Hanza records a rejection on the Offer and keeps the Connection
healthy (#68). Hanza never pushes a number to an ended Offer unless it ended
because it sold out and the connector declares `reopensSoldOutOffers: true`,
meaning its `stock.push` reactivates such an Offer when the number is above 0
(ADR 0022). Hanza decides from the publication it last pulled, which may be
stale, so a connector that declares it must check at push time why the Offer
ended, reopen it only if it sold out, and report `rejected` otherwise.

## Connectors

| Id | Package | Kind | What it is |
| --- | --- | --- | --- |
| `fake` | `@hanza/connector-fake` | marketplace | In-memory Channel for tests and demos, with every capability including `price.push`. Like Allegro, pushing 0 ends an Offer and a number above 0 reopens a sold-out one; the config field `rejectOffers` (and `channel.reject()` in tests) makes it refuse chosen Offers. The reference for how a connector looks. Not a real Channel. With `http: true` it also sends one request per call through `ctx.fetch`, answered by its in-memory `api` (for tests of rate limits and error mapping). |
| `fake-oauth` | `@hanza/connector-fake` | marketplace | The same in-memory data behind an OAuth sign-in (device flow, rotating tokens, installation settings). Only available where `HANZA_CONNECTOR_FAKE_OAUTH_CLIENT_ID` and `_CLIENT_SECRET` are set. Not a real Channel. |
| `fake-http` | `@hanza/connector-fake` | marketplace | Not registered. The same fake Channel behind a small JSON API with client-credentials tokens (`src/http/`), tested only with recorded fixtures: the reference for a connector that talks HTTP. |
| `fake-http-oauth` | `@hanza/connector-fake` | marketplace | Not registered. The same API with an OAuth life cycle shaped like Allegro's (installation settings, device flow, rotating refresh tokens; `src/http/oauth-connector.ts`), tested with recorded fixtures through `runConformance` (`app`, `refresh`, `deviceFlow`): the reference for an OAuth connector. |
| `allegro` | `@hanza/connector-allegro` | marketplace | The Allegro marketplace (production or sandbox). Offers in, Orders in (including Orders still awaiting payment, which get their `paid` fact once Allegro reports the payment), Stock out (0 ends the Offer; a number above 0 reopens an Offer that sold out), prices out (`price.push`: the buy-now price, refusals reported per Offer), Order phase out. No shipments or invoices yet. Signs in through the device flow and needs the installation settings `HANZA_CONNECTOR_ALLEGRO_CLIENT_ID`, `_CLIENT_SECRET`, `_ENVIRONMENT` and `_APP_NAME` (operator guide: "Connecting Allegro" in the [project README](../../README.md)); it stays hidden until they are set. Its cassettes come from an in-memory simulation of the Allegro API, written from the OpenAPI file and corrected to what the sandbox did when the connector was checked against it (2026-10-10; see its `AGENTS.md`). |

Allegro is the first real connector; WooCommerce is next (stage 2 of the plan).

## Recorded fixtures

Connector tests replay recorded HTTP traffic: CI has no network, no accounts
and no keys. `@hanza/connector-sdk/testing` records, scrubs, replays and lints
it (Node built-ins only). The reference is `packages/connectors/fake/src/http/`.

**Cassettes.** A cassette is one JSON file per scenario,
`src/fixtures/<scenario>.cassette.json`: a list of `{ request, response }`
interactions (method, URL, the kept headers, the body as `json`, `text` or
`base64`; status, headers, body). The conformance run is the scenario
`conformance`, plus `conformance-unauthorized` for check C11.

**The test.** One call runs the conformance kit on the cassettes:

```ts
import { runConformance } from '@hanza/connector-sdk/testing'

it('passes the conformance kit', () =>
  runConformance(connector, {
    fixtures: new URL('./fixtures', import.meta.url),
    config: {},
    credentials: { clientId: 'test-client', clientSecret: 'test-client-secret' }, // stand-ins, never real
    unauthorized: { credentials: { clientId: 'test-client', clientSecret: 'wrong-secret' } },
    scrub, // the connector's ScrubConfig
    recording: () => loadRecordingSetup(), // called only when recording
  }))
```

It lints the directory, replays the cassettes and fails with every request
they had no answer for, naming the nearest recorded requests and what differs.
A request matches on method, URL (query parameters sorted) and the hash of its
body; headers are ignored unless `match.headers` lists them. A JSON body is
compared by content (key order does not matter) only when it is sent with a
JSON `content-type`; any other body, including JSON sent without one (`fetch`
then labels a string `text/plain`), must match byte for byte. Identical
requests get their recorded answers in order, then the last one again.
Incoming requests are scrubbed like the recording first, so the test's
credentials never have to equal the recorded ones (use values of at least 8
characters, or declare the field). For other scenarios use
`openCassette(file, { scrub, recording })`, which lints its cassette on every
replay too; `withFetch(connector, fetch)`
hands a cassette to the engine in a database test, without the connector
knowing (see `apps/worker/src/recorded-fixtures.db.test.ts`).

**Recording from a sandbox.**

1. Put the sandbox credentials in `packages/connectors/<id>/.recording/`
   (ignored by git, for example `credentials.json`), and have the test's
   `recording()` read them and return
   `{ config?, credentials, secrets?, fetch?, close? }`. Never put them in the
   test, in `.env.example` or in a fixture.
2. Run the test directly, not through `pnpm test` (Turborepo's strict env mode
   hides the variable from it, on purpose):

   ```sh
   HANZA_RECORD_FIXTURES=1 pnpm --filter @hanza/connector-<id> exec vitest run src/connector.test.ts
   ```

   The kit runs against the real API and writes the cassettes, scrubbed. If
   anything still looks like a secret or personal data, nothing is written and
   the findings are listed: declare the field in the scrub config and record
   again. Recording is refused when `CI` is set.
3. Read the diff, then run the tests again without the variable.
4. Delete `.recording/` when you are done, and never copy it anywhere.

Recording runs every conformance check against the sandbox, including stock
pushes of 0 (which end Offers on some Channels) and every Order phase: use
sandbox data you can lose.

**Re-recording** is the same command; it overwrites the cassettes. Do it when
the connector's requests change on purpose (a replay miss says so) or when the
API changed. Placeholders are numbered in order of appearance, so recording
the same data again gives the same file.

**What the scrubber guarantees:**

- Request headers other than `accept` and `content-type`, and response headers
  other than `content-type`, `retry-after`, `location` and `link`, are never
  written (more only through `keepRequestHeaders` / `keepResponseHeaders`);
  `authorization`, `proxy-authorization`, `cookie` and `set-cookie` never.
- Values of secret-named JSON keys and URL or form parameters
  (`access_token`, `refresh_token`, `id_token`, `auth_token`,
  `session_token`, `bearer_token`, `x-auth-token`, `client_id`,
  `client_secret`, `device_code`, `user_code`, `code_verifier`, `password`,
  `api_key`, `token`, `secret`, … in any case, with or without `_` or `-`;
  `code` and `signature` as URL or form parameters only, since as JSON keys
  they usually hold error codes or Offer signatures), `Bearer` and `Basic`
  credentials and JWT-looking strings become `[scrubbed]`. So does every occurrence (URL-encoded too) of
  the recording credentials and of any value removed that way, in URLs,
  headers and bodies, earlier interactions included.
- E-mails outside the reserved domains (`example.com`, `*.test`, …) become
  `person-N@example.com`; `+`-prefixed phone numbers become `+000…N`.
- The connector's `ScrubConfig` (`keys`, `paths`, `queryParams`, `patterns`,
  each with a kind: `secret`, `email`, `phone`, or `text` → `scrubbed-N`)
  replaces whatever else it declares; a key that holds an object replaces every
  string below it. The same input gets the same placeholder within a
  recording, so references between responses still match. Ids are kept.
- A cassette is written only if the lint (`assertNoSecrets`) finds nothing.
  The same lint runs on every replay, over every `.json` file in the fixtures
  directory, hand-written ones included. It flags `Bearer`/`Basic`
  credentials, JWT-looking strings, unscrubbed secret-named values, credential
  headers, long token-shaped values under other `…token` or `…secret` keys
  (`csrfToken`; not cursors such as `nextPageToken`), real-looking e-mails,
  phone numbers, and 11-digit numbers with a valid PESEL date and checksum
  (outside id-like keys). List a known false positive in `allow`.

**What it does not guarantee:**

- Names, street addresses, postal codes, tax ids, free-text notes and national
  ids are personal data only the connector knows about: declare them in the
  scrub config. Neither the scrubber nor the lint recognises a name.
- A secret without a telling key, prefix or shape, that is not one of the
  recording credentials (an opaque token under an unusual key, or in a URL
  path segment), passes both. So does a known secret shorter than 8
  characters: it is not replaced literally.
- XML, HTML and plain-text bodies get only the pattern rules (no keys or
  paths), and a value hidden inside an encoded payload (base64, a signed
  blob, a nested URL-encoded string) is invisible to both.
- Phone numbers without a leading `+` are found only under phone-like keys,
  not in free text.
- Binary bodies can be neither scrubbed nor linted: they are dropped unless
  `keepBinaryBodies` is set, and then checking them is up to you.
- Requests that failed at the network level are not recorded.
- The lint matches patterns: it can be fooled, and it can flag a harmless
  value. Review the diff of every recording.
