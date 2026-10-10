# @hanza/connector-sdk

The contract between Hanza and its connectors: `defineConnector`, capability types, canonical zod schemas and the `ConnectorError` taxonomy. Connectors depend on this package and zod only.

## Authoring contract

A connector declares its identity, kind, configuration/credential schemas, authentication, capabilities and request limits. The core supplies a `CapabilityContext` with validated installation settings/configuration, decrypted credentials, a logger and rate-limited `fetch` with a timeout.

Channel connectors implement `offers.pull`, `orders.pull` and `stock.push`; price and Order phase pushes are optional capabilities. They reason about fixed Order phases, never an organization's Order statuses. The canonical model uses decimal-string Money and validated external data. An Order may carry its `delivery`: the method the Buyer chose and the pickup point.

A connector that makes Shipments (a courier, or a Channel with its own shipping) implements `shipments.create`, `shipments.track` and `shipments.label` together and declares its `shipping.services`; `shipments.cancel` is optional. `defineConnector` refuses a definition where these do not fit together.

| Capability | Contract |
| --- | --- |
| `shipments.create(ctx, request)` | Asks the Carrier for one Shipment. Repeatable: the same `reference` returns the Shipment the first call made, also when that call's answer was lost. Returns `created` with the Shipment's state (`pending` or `ready` for a new one), or `rejected` with a short code when the Carrier refuses this one request for good. Throws for every failure of the call, and for a refusal of the whole account (no funds, unpaid invoices, no contract with any carrier), which is a `PermanentError`, never `rejected`; a service the account does not have is `rejected`, since another service would work. |
| `shipments.track(ctx, externalIds)` | The current state of up to 100 Shipments. One left out of the answer is unchanged, and so is an id the Carrier does not know: it never fails the call for the others. No ids, no request. |
| `shipments.label(ctx, { externalId })` | The Label as `{ contentType, data }`. Throws `TransientError` while the Carrier has none yet. |
| `shipments.cancel(ctx, { externalId })` | Optional. `cancelled` when the Carrier confirmed the cancel or itself reports the Shipment as cancelled; `refused` with a short code when it is too late, or when the Carrier does not know the Shipment. Repeatable. |

**When a create is repeated.** The core never runs two creates of one Shipment at once, and never repeats a create whose outcome it does not know (the call threw, or its answer could not be stored) sooner than `SHIPMENT_CREATE_RETRY_DELAY_MS` (5 minutes) after that call started. A Carrier without an idempotency key can only make a create repeatable by looking the earlier Shipment up, and a Carrier's list may lag behind its own create: a lookup made at once finds nothing and the repeat buys a second parcel. A connector's lookup may rely on that delay and on nothing shorter. The one call repeated sooner is one in which the core's own rate limiter refused a request before sending it and nothing but reads (`GET`, `HEAD`) had left, so a connector never makes anything at the Carrier with a read. A repeat that finds the earlier Shipment in a state the connector cannot translate returns a lower bound (`ready` when it has a tracking number, else `pending`) and never throws.

The Shipment model lives in `src/model/shipment.ts`: `shipmentRequestSchema` (what Hanza asks for), `shipmentStateSchema` (where a Shipment is), the nine `SHIPMENT_STATUSES` with `isFinalShipmentStatus` and `isShipmentHandedOver`, the result schemas of the capabilities, and `shippingServiceSchema` with `shipmentRequestProblem`, which says whether a request fits a service. `delivery_problem` is a status of a parcel the Carrier has. Nothing a connector returns about a Shipment is free text: rejection codes and the Carrier's own status are short codes (`pushRejectionCodeSchema`), the Carrier's id is 1 to 100 letters, digits and `_ . : -`, and a tracking number the same with a space and `/`. The `reference` of a request is at most 64 letters, digits, `_` and `-` (the core sends the Shipment's UUID). The capability comments in `src/connector.ts` are the full contract.

See [the Commerce model glossary](CONTEXT.md) and [the connector guide](../connectors/README.md) for the complete contract, Order feed semantics and auth behaviour. The current contract has simulated reference implementations; validation against real Channels is [planned](../../docs/roadmap.md).

## Conformance and fixtures

`@hanza/connector-sdk/testing` provides `runConformance`, HTTP cassette recording/scrubbing/replay and fixture linting. Ordinary tests use recorded fixtures with no network or real accounts. Recording is a separate sandbox operation; review all recorded output for secrets and Buyer data before committing.

A connector with `shipments.create` passes `shipment: { request, rejected?: { request }, … }` and gets the shipment checks on top of the C checks:

| Check | What must hold |
| --- | --- |
| S1 | Every declared service is well formed, service and preset ids are unique, and the shipment capabilities come together. |
| S2 | `shipments.create` of the request fixture returns a valid `created` result whose status is `pending` or `ready`. The fixture must name a declared service and fit it. |
| S3 | `shipments.create` again with the same `reference` returns the same `externalId`. Before the repeat the kit waits `repeatWaitMs` (default 0, used only when recording). |
| S4 | `shipments.track` of that Shipment together with an id the Carrier does not know (`unknownExternalId`, default `"0"`) returns the Shipment's valid state and no other, and does not throw; with no ids it returns nothing and makes no request. |
| S5 | `shipments.label` returns a non-empty file with a content type. While it fails as `transient` the kit tracks the Shipment and asks again (`labelAttempts`, default 10; `labelWaitMs` between attempts, used only when recording). |
| S6 | With `rejected`: `shipments.create` returns `rejected` with a well-formed code and does not throw. |
| S7 | `shipments.cancel`, when implemented, returns one of its two outcomes on both of two calls, and never `refused` after `cancelled`. |
| S8 | `shipments.create` of the request fixture against a Carrier that answers every request `500` fails as `transient`: it neither resolves nor returns `rejected`. The 500 is the kit's own; nothing is recorded. A connector that makes no request (an in-memory Carrier) is not judged. |

For a connector without `orders.pull`, C11 (bad credentials fail as `auth_expired`) and C14 (a bare 403 does not) run against `shipments.track` of the Shipment S2 created. Every connector with `shipments.create` also gets C11 and C14 on a create of the request fixture, once S3 has seen that the repeat works: bad credentials must fail as `auth_expired` and a bare 403 must not, and neither may come back as `rejected`, which would fail the Shipment for good. C12 (every rejection is a `ConnectorError`) covers the shipment capabilities too.

What this asks of the cassettes:

- **`conformance.cassette.json`** holds one write for each Shipment the kit asked for: on a replay of a connector with `shipments.create`, a recorded write (any method but `GET` and `HEAD`) is served as often as it was recorded and then counts as an unmatched request, so a second `POST` of the same Shipment fails the run instead of getting the first answer again (`match.exhausted: 'repeat-reads'`, set by `runConformance`; reads still repeat their last answer). A connector that posts twice fails on its own cassette.
- **`conformance-unauthorized.cassette.json`** holds what the connector sends with the refused credentials for `shipments.track` of the created Shipment (a connector without `orders.pull`) and then for `shipments.create` of the request fixture: for a connector that looks an earlier Shipment up first, that is the lookup answered 401, and no `POST`.
- The 403 of C14 and the 500 of S8 come from the kit and are in no cassette.
- **Recording** needs a `reference` no earlier run used (a repeatable create hands back that run's Shipment, in whatever status it has by now, and S2 fails), and a `repeatWaitMs` as long as the Carrier's list lags behind its own create: the core never repeats a create at once, so a recording made without the wait shows a second Shipment the core would not have caused. `labelWaitMs` and `repeatWaitMs` are never used on a replay.

A Label is a binary body, which the scrubber drops because it can neither scrub nor lint it, and a replayed empty Label fails S5. Record with `scrub: { replaceBinaryBodies: true }`: the cassette then holds a blank placeholder PDF in place of the Carrier's file, which prints a name and an address. `keepBinaryBodies` keeps the real file and is not for Labels.

Run `pnpm typecheck` and `pnpm test` from the root. The [fake connector](../connectors/fake/README.md) demonstrates the SDK and test kit.

Changing the SDK contract or canonical schemas requires a reviewed GitHub spec and explicit approval before implementation. Update all affected mappings/connectors and stored models when an approved change is made. See [CONTRIBUTING.md](../../CONTRIBUTING.md).
