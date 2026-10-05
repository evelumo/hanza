# Work after commit is best-effort; stock pushes are recovered from counters in the database

A service commits a change and then enqueues follow-up work (a stock push, an Order status push, a rematch of Unmatched lines). If that enqueue fails and the operation fails with it, the caller retries something that already happened and gets `sku_taken` or `invalid_transition`. We decided a failure after commit is logged with ids only and never fails the operation. Stock pushes do not rely on the enqueue arriving: every change to Available bumps a per-Offer counter in the same transaction, an Offer needs a push while its counter is ahead of the last pushed one, a push marks only what it sent, and the scheduler's sweep every 10 minutes pushes whatever is still ahead. Job payloads only identify what to work on; handlers read current state, so coalescing jobs loses nothing.

## Consequences

- An Order status push whose enqueue failed is recovered by the tick's sweep of pushes marked pending on the Order (ADR 0011, which amends this one; before it, issue #13).
- A new post-commit step must say how its skipped work is recovered, or accept that it is not.
