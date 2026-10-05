# Buyer data is sealed in the core and erased in place; the Order stays

Orders carry the Buyer's name, contact details and addresses, which must be protected at rest, erased after a retention period and erased for one person on request (issue #6). We decided that the core seals the whole Buyer snapshot of an Order as one value with the existing `SecretBox` (AES-256-GCM, `HANZA_ENCRYPTION_KEY`, bound by its authenticated data to the organization, Connection and Order number), finds a person's Orders only through a keyed HMAC of the normalised email (a blind index, exact match), and erases by clearing the sealed value, the index and Channel fact notes while keeping the Order, its lines, amounts, status, dates and shipping country. Connectors keep receiving and returning plaintext canonical Orders. Sealing in application code keeps the key out of SQL and logs, one value per Order matches how the panel reads it, and erasing in place instead of deleting the Order keeps stock history, accounting totals and the Event trail intact.

## Considered options

- One sealed column per field: more columns and seals for no gain; the panel always reads the whole snapshot.
- Encryption in Postgres (pgcrypto): the key would travel in queries and could end up in logs.
- Deleting old Orders for retention: breaks Reservation history, totals and the audit trail.

## Consequences

- No search by Buyer except exact email, and only for erasure requests. Name or address search would need another design.
- The Retention period counts from `closedAt`, when an Order became shipped or cancelled. Open Orders are never erased, not even on an erasure request, because their address is needed to ship them.
- Scheduling follows ADR 0008: one global hourly `privacy.tick` lists organization ids and enqueues a coalesced `privacy.sweep` per organization, which seals legacy rows and then applies the Retention period in bounded batches.
- Rows written before this change are sealed by `privacy.sweep`; the plaintext columns stay nullable until a later migration drops them (issue #31). Key rotation is not built; the `v1` prefix of sealed values and digests leaves room for it (issue #30).
- Every Erasure appends an `order.buyer_data_erased` Event and an erasure request appends `privacy.erasure_requested`; neither holds the email or any other personal data.
