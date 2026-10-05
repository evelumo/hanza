# The connector registry is its own package, so the core never depends on a connector

The core has to run connectors, but if it imported them, every connector would become part of the core's dependency graph and could leak into its code and tests. We decided the list of connectors in a build lives in `@hanza/connector-registry`, the only package that depends on connector packages; each app imports it and passes the definitions to `createContext({ connectors })`. Adding a connector is one dependency and one line in the registry. `pnpm check:boundaries` fails if the core, the database package or the SDK depends on a connector or the registry, or if anything but the registry lists a connector in `dependencies`. Core tests use inline connectors built with `defineConnector`.

## Consequences

- An app that forgets to pass the registry runs with no connectors; `createContext` does not fail.
- Connector auto-discovery (a generated registry) stays possible later without touching the core.
