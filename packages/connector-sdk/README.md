# @hanza/connector-sdk

The contract between Hanza and its connectors: `defineConnector`, capability types, canonical zod schemas and the `ConnectorError` taxonomy. Connectors depend on this package and zod only.

## Authoring contract

A connector declares its identity, kind, configuration/credential schemas, authentication, capabilities and request limits. The core supplies a `CapabilityContext` with validated installation settings/configuration, decrypted credentials, a logger and rate-limited `fetch` with a timeout.

Channel connectors implement `offers.pull`, `orders.pull` and `stock.push`; price and Order phase pushes are optional capabilities. They reason about fixed Order phases, never an organization's Order statuses. The canonical model uses decimal-string Money and validated external data. An Order may carry its `delivery`: the method the Buyer chose and the pickup point.

A connector that makes Shipments (a courier, or a Channel with its own shipping) implements `shipments.create`, `shipments.track` and `shipments.label` together and declares its `shipping.services`; `shipments.cancel` is optional. `defineConnector` refuses a definition where these do not fit together.

| Capability | Contract |
| --- | --- |
| `shipments.create(ctx, request)` | Asks the Carrier for one Shipment. Repeatable: the same `reference` returns the Shipment the first call made, also when that call's answer was lost. Returns `created` with the Shipment's state, or `rejected` with a short code when the Carrier refuses the request for good; throws only for a failure of the call. |
| `shipments.track(ctx, externalIds)` | The current state of up to 100 Shipments. One left out of the answer is unchanged. No ids, no request. |
| `shipments.label(ctx, { externalId })` | The Label as `{ contentType, data }`. Throws `TransientError` while the Carrier has none yet. |
| `shipments.cancel(ctx, { externalId })` | Optional. `cancelled`, or `refused` with a short code when it is too late. Repeatable. |

The Shipment model lives in `src/model/shipment.ts`: `shipmentRequestSchema` (what Hanza asks for), `shipmentStateSchema` (where a Shipment is), the nine `SHIPMENT_STATUSES` with `isFinalShipmentStatus` and `isShipmentHandedOver`, the result schemas of the capabilities, and `shippingServiceSchema` with `shipmentRequestProblem`, which says whether a request fits a service. Rejection codes and the Carrier's own status are short codes (`pushRejectionCodeSchema`), never free text. The capability comments in `src/connector.ts` are the full contract. The core does not call these capabilities or store an Order's `delivery` yet: that side is **planned** ([#126](https://github.com/evelumo/hanza/issues/126)).

See [the Commerce model glossary](CONTEXT.md) and [the connector guide](../connectors/README.md) for the complete contract, Order feed semantics and auth behaviour. The current contract has simulated reference implementations; validation against real Channels is [planned](../../docs/roadmap.md).

## Conformance and fixtures

`@hanza/connector-sdk/testing` provides `runConformance`, HTTP cassette recording/scrubbing/replay and fixture linting. Ordinary tests use recorded fixtures with no network or real accounts. Recording is a separate sandbox operation; review all recorded output for secrets and Buyer data before committing.

A connector with `shipments.create` passes `shipment: { request, rejected?: { request } }` and gets the shipment checks on top of the C checks:

| Check | What must hold |
| --- | --- |
| S1 | Every declared service is well formed, service and preset ids are unique, and the shipment capabilities come together. |
| S2 | `shipments.create` of the request fixture returns a valid `created` result whose status is not final. The fixture must name a declared service and fit it. |
| S3 | `shipments.create` again with the same `reference` returns the same `externalId`. |
| S4 | `shipments.track` of that Shipment returns its valid state and no other; with no ids it returns nothing and makes no request. |
| S5 | `shipments.label` returns a non-empty file with a content type. While it fails as `transient` the kit tracks the Shipment and asks again (`labelAttempts`, default 10; `labelWaitMs` between attempts, used only when recording). |
| S6 | With `rejected`: `shipments.create` returns `rejected` with a well-formed code and does not throw. |
| S7 | `shipments.cancel`, when implemented, returns one of its two outcomes on both of two calls, and never `refused` after `cancelled`. |

For a connector without `orders.pull`, C11 (bad credentials fail as `auth_expired`) and C14 (a bare 403 does not) run against `shipments.track` of the Shipment S2 created; C12 (every rejection is a `ConnectorError`) covers the shipment capabilities too.

A Label is a binary body, which the scrubber drops because it can neither scrub nor lint it, and a replayed empty Label fails S5. Record with `scrub: { replaceBinaryBodies: true }`: the cassette then holds a blank placeholder PDF in place of the Carrier's file, which prints a name and an address. `keepBinaryBodies` keeps the real file and is not for Labels.

Run `pnpm typecheck` and `pnpm test` from the root. The [fake connector](../connectors/fake/README.md) demonstrates the SDK and test kit.

Changing the SDK contract or canonical schemas requires a reviewed GitHub spec and explicit approval before implementation. Update all affected mappings/connectors and stored models when an approved change is made. See [CONTRIBUTING.md](../../CONTRIBUTING.md).
