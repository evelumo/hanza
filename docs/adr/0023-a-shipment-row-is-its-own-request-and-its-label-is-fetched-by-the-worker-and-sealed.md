# A Shipment row is its own request, and its Label is fetched by the worker and sealed

Status: accepted (issue #126)

A person asks for a Shipment in the panel, but only the worker opens a Connection's credentials, and a Carrier such as InPost has no idempotency key: a create that is repeated blindly buys a second parcel. We decided the `shipment` row is the request. `requestShipment` inserts it as `requested` and due (`nextCheckAt`, swept by `sync.tick` like the pending status push of ADR 0012); the `shipments.create` job asks the Carrier with the row's id as `reference` and its `createdAt` as `requestedAt`, and stores the answer, so a job that died after the Carrier answered leaves a row that still asks, and its retry gets the same Shipment back from the connector, which must find it by that reference. A lease on the row (`createLeaseUntil`, five minutes) keeps two runs from asking at once, the one case a lookup cannot cover. The Label is fetched by `shipments.track` once the Carrier confirms the Shipment and stored in the row, sealed with `SecretBox` and bound to the organization and the Shipment, next to the destination a person confirmed, sealed the same way. Both are Buyer data (ADR 0016): the Label prints a name and an address, and a pickup point is usually a few streets from the Buyer's home.

## Considered options

- An outbox table of shipment requests: a second row to scope, deduplicate and clean up for what the Shipment already says about itself.
- Calling the Carrier from the panel's request: the web process would open credentials, which it never does, and a slow Carrier would hold the request.
- Fetching the Label when a person downloads it: the same, on every download.
- Storing a link to the Label: ShipX has no public one, and a link would put the Buyer's address outside the sealed data.
- Copying the address into the Shipment: a second sealed copy to erase; the Order's own is read when the Carrier is asked.

## Consequences

- A connector's `shipments.create` must be repeatable by `reference`; the core never calls it for a Shipment that has an `externalId` or left `requested`, and only with a request that names a service the connector declares and fits it (checked when the person asks and again in the job).
- The tick claims overdue `requested` Shipments and enqueues one `shipments.create` each (one per tick while the Connection is failing). For Shipments the Carrier knows it only enqueues the Connection's `shipments.track`, and that job claims its own batch of at most 100: its payload names the Connection, not the Shipments, so a claim by the tick would leave it nothing to find. A batch whose call failed is given back at once when the queue or a sign-in will retry it soon; after a refusal for good or the last attempt it waits out the claim (10 minutes).
- Cancelling runs in `shipments.track` too, before the states of the same batch, so one job per Connection is the only writer of what a Carrier says about a Shipment it knows. A Shipment the Carrier was never successfully asked for, and is not being asked for right now, is cancelled without a call.
- The SDK cannot ask "does a Shipment with this reference exist" without creating one. So a Shipment cancelled locally, or timed out, after a create whose answer was lost may still exist at the Carrier; `createAttempts` above 0 and the `createAttempted` mark on the Event say when that is possible. A lookup capability would close it.
- Checks follow the status: every tick for the first 10 minutes while unconfirmed, then every 10 minutes; every 15 minutes when ready; hourly once the Carrier has the parcel. Unconfirmed after 24 hours it fails with `carrier_timeout`, also when the Connection waited for sign-in all that time; not final after 60 days it is no longer checked.
- A final status deletes the Label. An Erasure of the Order's Buyer data clears the Label and the destination of its Shipments, and a Label is neither fetched nor stored for an erased Order (the store takes the Order lock, which an Erasure waits for). Status, Carrier status and tracking number stay in plaintext.
- The panel reads Shipments without the sealed columns and learns that a Label exists from `labelContentType` (set and cleared with it, by a CHECK). A Label is served with a content type from an allow-list (PDF, PNG, printer commands as plain text, otherwise a download), whatever the connector called it.
- A sealed Label sits in a text column, at most 5 MB of file; larger answers are dropped and logged by Shipment id.
- A `courier` Connection now has sync state (`shipments_create`, `shipments_track`) and health like a Channel's.
