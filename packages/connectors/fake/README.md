# @hanza/connector-fake

Simulated Channel implementations for demos, deterministic engine tests and SDK conformance. They are reference connectors, not live marketplace integrations.

| Connector id | Implementation | Panel availability |
| --- | --- | --- |
| `fake` | In-memory Channel with API-key stand-ins | Test channel |
| `fake-oauth` | Same data with device-flow sign-in and rotating tokens | Test OAuth channel; requires demo installation settings |
| `fake-courier` | In-memory Carrier: Shipments, tracking, Label, cancel | Test courier |
| `fake-http` | JSON API with client-credentials authentication | Test reference only, not registered |
| `fake-http-oauth` | JSON API with device flow and token refresh | Test reference only, not registered |

## Demo data and behaviour

`src/seed.ts` supplies five Offers, four Orders and Channel facts. API keys identify simulated accounts; use a distinct stand-in for each new demo Connection. The key `expired` simulates an authentication failure.

The in-memory remote state resets when the worker restarts. Tests can inspect calls and make chosen Offers reject Stock/price pushes. Pushing zero ends an Offer as sold out; a positive value may reopen a sold-out Offer under the connector contract.

Follow [the demo walkthrough](../../../docs/demo.md) for the manual Test channel path and optional OAuth screen settings. OAuth approval uses a placeholder provider URL and is simulated by the E2E probe, rather than completed on a live site. `src/http/` and its recorded fixtures demonstrate network connectors without requiring external accounts during replay.

## Fake courier

`fake-courier` (`src/courier.ts`) is the Carrier the Shipment tests, the demo and the e2e flows use. It needs no credentials and keeps its Shipments in memory, so they are gone when the worker restarts.

- **Services.** `locker` ("Fake locker", a pickup point, parcel presets `small`, `medium`, `large`, cash on delivery) and `courier` ("Fake courier", an address, parcel dimensions, cash on delivery).
- **Progress.** A new Shipment is `pending` (Carrier status `created`) and has its tracking number (`FAKE000001`, `FAKE000002`, ...). Each `shipments.track` moves every Shipment it is asked about one step: `ready` (`confirmed`), `in_transit` (`collected`), `delivered` (`delivered`). A cancelled one is `cancelled` and stays so.
- **Label.** A `TransientError` while the Shipment is `pending`, a one-page PDF with its tracking number from `ready` on.
- **Cancel.** `cancelled` while `pending` or `ready` (and for one already cancelled), `refused` with `too_late` once the Carrier has the parcel and with `shipment_unknown` for a Shipment the account does not have.
- **Config.** `stuckAt` (`none`, `pending`, `ready`, `in_transit`) holds every Shipment at that status, to keep one `ready` for a Label or a cancel. `rejectPickupPoints` (comma-separated) makes `shipments.create` return `pickup_point_unknown` for those points; a pickup point request whose receiver has no phone is refused with `receiver_phone_missing`. `account` (default `default`): Connections with the same account share their Shipments, another account neither sees nor changes them.
- **Tests.** `createFakeCourier()` (registered instance: `fakeCourier`) exposes `shipments` (what the Carrier keeps), the calls `creates`, `tracks`, `labels` and `cancels`, and `reset()`. A repeated `reference` returns the Shipment it made and creates nothing.
- **Seed.** The fake Channel's Orders carry a Delivery: `fake-order-1` and `fake-order-4` to the pickup points `FAKE01` and `FAKE02`, `fake-order-2` by courier, `fake-order-3` none (a Channel that does not say). The two that go to a pickup point have a phone (`SEED_PHONE`, a number nobody has), so the locker service takes them; `fake-order-3` has none, so a pickup point typed for it shows the refusal `receiver_phone_missing`.

## Test and extend

From the repository root:

```sh
pnpm --filter @hanza/connector-fake test
pnpm check:boundaries
```

Read [the local agent guide](AGENTS.md) before editing and [the connector guide](../README.md#recorded-fixtures) for cassette rules. Keep tests deterministic and network-free; do not replace stand-ins with real credentials.
