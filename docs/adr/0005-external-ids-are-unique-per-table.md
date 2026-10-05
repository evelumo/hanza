# Each synced table keeps its own unique Channel key; there is no generic external-reference table

Everything pulled from a Channel needs an idempotency key, because pulls are retried and re-read. We decided each synced table carries its Channel identifier with its own unique constraint: Offer and Order by `(connectionId, externalId)`, Order line and Channel fact by `(orderId, externalId)`. A generic table mapping Hanza ids to external ids would let a concurrent duplicate through unless the mapping and the row were written atomically, and it adds a join to every read. With the constraint on the row itself, a concurrent duplicate insert fails, the job retries and takes the "already exists" path. Products have no external ids: Hanza owns them.

## Consequences

- A new synced table must define its own Channel key and unique constraint.
- There is no single place to ask what an object is called on a Channel; ask the table that holds it.
