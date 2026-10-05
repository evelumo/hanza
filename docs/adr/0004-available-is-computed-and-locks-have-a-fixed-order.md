# Available is computed, never stored, and writers lock the Order before Stock

Available is what Hanza tells Channels, so a wrong value sells goods that do not exist (ADR 0001). A stored counter would have to be kept equal to Stock minus open Reservations by every write path, forever. We decided Available is always computed in one statement (Stock over all Warehouses minus open Reservations), and that every transaction that changes Stock or Reservations takes row locks in a fixed order: the Order row first, then the Stock rows of the Products involved, sorted by Product. Available is read only after the locks are held, under Postgres' default READ COMMITTED, so the value a Reservation is checked against is exact. Serialisable transactions were rejected: they turn the same contention into retries scattered across the code.

## Consequences

- Any new code that touches Stock or Reservations must take the locks in this order (`lockOrder`, then `lockStock`), or it can deadlock with the existing write paths or reserve against a stale value.
- Available can go below zero when two Channels sell the last unit at once; the Order line becomes a Shortage and a person decides. The value pushed to a Channel is never below zero.
