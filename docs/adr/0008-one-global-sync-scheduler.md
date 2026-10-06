# One global `sync.tick` decides what to sync, instead of a schedule per Connection

Every Channel Connection needs its Offers, Orders and stock pushed on a timer. We decided on a single repeating job, `sync.tick`, every minute: it lists all Connections and enqueues each stream that is due (by its last start time) with a coalescing key, skipping Connections that wait for the organization to sign in again. A schedule per Connection would have to be created, updated and deleted in the queue in step with the Connections table, and a missing or stale one would silently stop a Connection syncing. The tick reads the database each minute, so a new Connection is picked up with no extra step, and a lost schedule cannot strand one.

## Consequences

- Timing is coarse (one-minute granularity, with half a tick of slack so a stream is not skipped when a run started just after its tick) and the intervals are the same for every Connection.
- The tick reads every Connection of every organization (ids, connector id, health, timestamps): a cross-tenant read, like the workflow sweep it also enqueues (ADR 0014) and `privacy.tick`, which lists organization ids the same way (ADR 0016). It will need paging or sharding at a scale this design does not yet target.
