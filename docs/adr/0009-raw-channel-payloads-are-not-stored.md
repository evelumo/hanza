# Raw Channel payloads are not stored

Keeping each Channel response would make it possible to replay an import and to debug a connector against what the Channel really sent. We decided Hanza stores only the canonical Order and Offer a connector returns, validated with the SDK schemas. A raw payload carries the Buyer's personal data in whatever shape the Channel uses, outside the tables where encryption, retention and erasure can be applied (issue #6). Connector bugs are reproduced with fixtures instead.

## Consequences

- A field added to the canonical model later is filled only for Orders pulled after the change, not backfilled from history.
- An Order that reached Hanza wrongly cannot be re-imported from a stored copy; it has to come from the Channel again.
