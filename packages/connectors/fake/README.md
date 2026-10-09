# @hanza/connector-fake

Simulated Channel implementations for demos, deterministic engine tests and SDK conformance. They are reference connectors, not live marketplace integrations.

| Connector id | Implementation | Panel availability |
| --- | --- | --- |
| `fake` | In-memory Channel with API-key stand-ins | Test channel |
| `fake-oauth` | Same data with device-flow sign-in and rotating tokens | Test OAuth channel; requires demo installation settings |
| `fake-http` | JSON API with client-credentials authentication | Test reference only, not registered |
| `fake-http-oauth` | JSON API with device flow and token refresh | Test reference only, not registered |

## Demo data and behaviour

`src/seed.ts` supplies five Offers, four Orders and Channel facts. API keys identify simulated accounts; use a distinct stand-in for each new demo Connection. The key `expired` simulates an authentication failure.

The in-memory remote state resets when the worker restarts. Tests can inspect calls and make chosen Offers reject Stock/price pushes. Pushing zero ends an Offer as sold out; a positive value may reopen a sold-out Offer under the connector contract.

Follow [the demo walkthrough](../../../docs/demo.md) for the manual Test channel path and optional OAuth screen settings. OAuth approval uses a placeholder provider URL and is simulated by the E2E probe, rather than completed on a live site. `src/http/` and its recorded fixtures demonstrate network connectors without requiring external accounts during replay.

## Test and extend

From the repository root:

```sh
pnpm --filter @hanza/connector-fake test
pnpm check:boundaries
```

Read [the local agent guide](AGENTS.md) before editing and [the connector guide](../README.md#recorded-fixtures) for cassette rules. Keep tests deterministic and network-free; do not replace stand-ins with real credentials.
