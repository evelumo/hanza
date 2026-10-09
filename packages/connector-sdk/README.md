# @hanza/connector-sdk

The contract between Hanza and its connectors: `defineConnector`, capability types, canonical zod schemas and the `ConnectorError` taxonomy. Connectors depend on this package and zod only.

## Authoring contract

A connector declares its identity, kind, configuration/credential schemas, authentication, capabilities and request limits. The core supplies a `CapabilityContext` with validated installation settings/configuration, decrypted credentials, a logger and rate-limited `fetch` with a timeout.

Channel connectors implement `offers.pull`, `orders.pull` and `stock.push`; price and Order phase pushes are optional capabilities. They reason about fixed Order phases, never an organization's Order statuses. The canonical model uses decimal-string Money and validated external data.

See [the Commerce model glossary](CONTEXT.md) and [the connector guide](../connectors/README.md) for the complete contract, Order feed semantics and auth behaviour. The current contract has simulated reference implementations; validation against real Channels is [planned](../../docs/roadmap.md).

## Conformance and fixtures

`@hanza/connector-sdk/testing` provides `runConformance`, HTTP cassette recording/scrubbing/replay and fixture linting. Ordinary tests use recorded fixtures with no network or real accounts. Recording is a separate sandbox operation; review all recorded output for secrets and Buyer data before committing.

Run `pnpm typecheck` and `pnpm test` from the root. The [fake connector](../connectors/fake/README.md) demonstrates the SDK and test kit.

Changing the SDK contract or canonical schemas requires a reviewed GitHub spec and explicit approval before implementation. Update all affected mappings/connectors and stored models when an approved change is made. See [CONTRIBUTING.md](../../CONTRIBUTING.md).
