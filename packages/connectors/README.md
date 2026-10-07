# Connectors

One directory per connector, each its own package (`@hanza/connector-<id>`).

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

- Cursor `null` returns the Orders open on the Channel now, then follows the
  journal from a position taken before that listing; Orders closed before the
  Connection never arrive. The cursor is opaque: encode the phase in it.
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

## Connectors

| Id | Package | Kind | What it is |
| --- | --- | --- | --- |
| `fake` | `@hanza/connector-fake` | marketplace | In-memory Channel for tests and demos, with every capability including `price.push`. The reference for how a connector looks. Not a real Channel. With `http: true` it also sends one request per call through `ctx.fetch`, answered by its in-memory `api` (for tests of rate limits and error mapping). |
| `fake-http` | `@hanza/connector-fake` | marketplace | Not registered. The same fake Channel behind a small JSON API with client-credentials tokens (`src/http/`), tested only with recorded fixtures: the reference for a connector that talks HTTP. |

Allegro and WooCommerce come first among the real ones (stage 2 of the plan).

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
pushes of 0 (which end Offers on some Channels) and every Order status: use
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
