# Buyer data is sealed in the core and erased in place; the Order stays

Orders carry the Buyer's name, contact details and addresses, which must be protected at rest, erased after a retention period and erased for one person on request (issue #6). We decided that the core seals the whole Buyer snapshot of an Order as one value with the existing `SecretBox` (AES-256-GCM, `HANZA_ENCRYPTION_KEY`, bound by its authenticated data to the organization, Connection and Order number), finds a person's Orders only through a keyed HMAC of the organization id and the normalised email (a blind index, exact match), and erases by clearing the sealed value, the index and Channel fact notes while keeping the Order, its lines, amounts, status, dates and shipping country. Connectors keep receiving and returning plaintext canonical Orders. Sealing in application code keeps the key out of SQL and logs, one value per Order matches how the panel reads it, and erasing in place instead of deleting the Order keeps stock history, accounting totals and the Event trail intact.

## Considered options

- One sealed column per field: more columns and seals for no gain; the panel always reads the whole snapshot.
- Encryption in Postgres (pgcrypto): the key would travel in queries and could end up in logs.
- Deleting old Orders for retention: breaks Reservation history, totals and the audit trail.

## Consequences

- No search by Buyer except exact email (Unicode NFC, trimmed, lowercased), and only for erasure requests. The organization id is part of the HMAC input, so the same Buyer cannot be linked across organizations by reading the database. Legacy rows are matched on their plaintext with `=`, never `LIKE`, trimmed in SQL with exactly the characters JS `trim()` strips. Known limit: SQL `lower()` follows the database's LC_CTYPE, so for non-ASCII letters a legacy row may fold case differently from JS until the sweep seals it; ASCII always agrees.
- A stored value that does not open (wrong or rotated key, damage) shows that one Order as "cannot be read" and logs its id; it never fails a whole list.
- The Retention period counts from `closedAt`, when an Order became shipped or cancelled; Orders closed before this change count from their last change (`updatedAt`), so turning retention on can erase many old Orders at once. The panel shows that count and asks for confirmation first. Open Orders are never erased, not even on an erasure request, because their address is needed to ship them.
- Changing the Retention period and handling an Erasure request are limited to the organization's owners and admins (Better Auth `member.role`), checked in the core services.
- Scheduling follows ADR 0008: one global hourly `privacy.tick` lists organization ids and enqueues a coalesced `privacy.sweep` per organization, which fills a missing `closedAt`, seals legacy rows, then applies the Retention period, in bounded batches. A legacy row that fails the schema is marked (`buyerDataSealFailedAt`), logged by id and skipped; it keeps its plaintext until retention or an erasure request clears it.
- A Channel fact pulled after an Order's Buyer data was erased is stored without its note.
- Rollout: apply the migration, then restart web and worker together; panel code from before this change cannot read sealed rows. Rows written before this change are sealed by `privacy.sweep`; the plaintext columns stay nullable until a later migration drops them (issue #31). Key rotation is not built; the `v1` prefix of sealed values and digests leaves room for it (issue #30).
- BullMQ keeps the error message and stack of failed jobs in Redis. On the import path these only ever see sealed Buyer data, never plaintext.
- Hanza remembers no erased Buyer: adding the same Channel account again as a new Connection re-imports its old Orders with full Buyer data, and open Orders kept by an erasure request are not erased when they later close (issues #66, #67).
- Every Erasure appends an `order.buyer_data_erased` Event and an erasure request appends `privacy.erasure_requested`; neither holds the email or any other personal data.
