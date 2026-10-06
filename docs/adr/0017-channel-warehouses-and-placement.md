# A Channel counts a set of Warehouses, is told what one of them can cover, a Reservation sits in one, and Warehouse rows join the lock order

Status: accepted. Amends ADR 0004 (lock order, Shortage) and ADR 0013 (what a Channel's number and its Reservations are based on).

Sellers keep stock in several Warehouses and want each Channel to sell only from some of them (issue #4). We decided:

- **Channel Warehouses.** Each Channel counts either every active Warehouse (the default, including ones added later) or an explicit set of them. Available becomes per Warehouse: Stock minus open Reservations there.
- **What a Channel is told.** For each Product, a Channel is told `channelAvailable(min(Σ Available, max Available))` over its Warehouses: the smaller of their total and the largest single one, then its Safety buffer and Channel limit (ADR 0013). This is still computed only in `getChannelAvailability`.
- **Placement.** A Reservation is placed whole in the first of the Order's Channel's Warehouses, in priority order (lower first, then id), whose Available covers the line. When none covers it, the line is a Shortage and goes to the one of them with the largest Available (the first such one in order).
- **Moving.** A person may move an open Reservation to any active Warehouse that covers it.

In a one-Warehouse organization all of this reduces to the old rules exactly.

We chose this because a Channel must never be told more than its own Warehouses can fulfil, and lines are never split:

- The largest single Warehouse caps what one line can get without a Shortage, so any line no larger than the number a Channel was told is covered by one of its Warehouses (when the number is fresh).
- The sum keeps units owed by an oversold Warehouse counted, so the number errs low, never high.

Judging an Order only against its Channel's Warehouses keeps that number honest. A single priority list and no line splitting keep the rule simple, deterministic and easy to explain.

## Shortages that still happen, and who sees them

A Shortage can now only come from a number that is no longer fresh: a push that has not arrived yet, two Channels selling the same last units at once, or a seller editing a listing by hand. The line then goes where the fewest units are owed (the largest Available), and that Warehouse goes below zero by that many units. Through the sum, this lowers what every Channel counting that Warehouse is told, to zero if need be.

It does **not** lower what a Channel that does not count that Warehouse is told. For example: main −1 after the Shortage, north 2. A north-only Channel is still told 2. That is correct, not a gap: north's 2 units are physically there and promised to nobody. The Shortage belongs to main, and a person settles it by restocking main, moving the line once some Warehouse covers it, or cancelling.

Counting main's deficit against north would hide real, free units from the north Channel. It would also not make the short Order shippable, because the line cannot be split.

## Lock order

Every transaction takes its locks in this order and skips the steps it does not need:

1. the Order row (`lockOrder`, `FOR NO KEY UPDATE`);
2. the organization's Warehouse rows, `FOR SHARE`, in id order;
3. the Stock rows of the Products involved in those Warehouses, sorted by Product then Warehouse, after creating missing ones;
4. Offers, in id order.

`lockStock` does steps 2 and 3 in one call. It reads the Warehouses on the first call in a transaction only, and locks only Stock rows of Warehouses it has share-locked. `lockStock` and `lockOrder` refuse the plain database client: outside a transaction a row lock would be released at once.

Changing a Channel's Warehouses takes the Connection row (`FOR NO KEY UPDATE`), then step 2, then its choice rows, then step 4. Updating, deactivating or deleting a Warehouse takes only that one Warehouse row:

- an update or a (de)activation takes `FOR NO KEY UPDATE`;
- a delete takes `FOR UPDATE`.

Both conflict with `FOR SHARE`. After that lock, the transaction waits only for that Warehouse's own Stock rows, which only a holder of its share lock could have locked.

This cannot deadlock:

- Share locks do not conflict with each other.
- A Warehouse-management transaction holds a single lock and never waits on a row that a transaction blocked by it could hold.
- A Warehouse created during a transaction is never locked by it after a Stock row.
- No transaction takes a Connection lock after a Stock lock. An Order insert takes only KEY SHARE on its Connection, which does not conflict.

## Considered options

- **Telling a Channel the sum over its Warehouses: rejected.** The review of #74 showed it oversells with no race. With main 3 and north 2, an all-Warehouses Channel was told 5. A line of 5 became a Shortage in main, while a north-only Channel was still told north's 2 and sold them. Five units of Stock ended up with seven reserved.
- **Telling a Channel only the largest single Warehouse: rejected.** It would ignore units owed by an oversold Warehouse and could tell more than the Warehouses can fulfil in total.
- **A Shortage in the first Warehouse by priority: replaced.** The Warehouse with the most Available owes the fewest units and needs the smallest restock.
- **Shortage judged against the sum over the Channel's Warehouses: rejected.** A line could pass while no single Warehouse can ship it.
- **Per-Channel priority order: deferred to #73.** One organization-wide order is enough to start.
- **Locking the Connection row while reserving, so a concurrent change of its Warehouses waits: rejected.** The choice is read without a lock and applies to the next Order. The Available it is checked against is still read under the Stock locks.
- **Treating "no chosen Warehouses" as "all": rejected.** Deleting the last chosen Warehouse would silently widen what the Channel is told.

## Consequences

- **Stock spread thin is under-advertised.** Ten Warehouses holding 1 unit each tell a Channel 1, not 10, and 4 + 6 tells 6. This is the price of never splitting a line. Splitting lines across Warehouses (#70) is what lifts it.
- **An inactive Warehouse holds nothing.** It has no Stock, no open Reservations, and no Channel chose it: deactivating and deleting are refused otherwise, and the default Warehouse can be neither deactivated nor deleted.
- **Warehouse changes never change a Channel's number, so they need no push.**
  - An empty Warehouse joining or leaving a Channel's set changes neither the sum nor any positive largest value. A largest value of 0 instead of a negative one is still told as 0.
  - Priority only affects where future Reservations go.
  - A test checks all of this for create, rename, reorder, (de)activate and delete.
  - Changing a Channel's Warehouses does change its number, and bumps its Offers' push sequence in the same transaction.
- **Warehouse edits can wait.** A Warehouse edit or (de)activation waits for every in-flight writer of Stock in the organization, because each holds the Warehouse rows `FOR SHARE`. Under steady import load, new share locks can keep being granted ahead of the waiting edit, which can then wait up to the transaction timeout and fail; a retry then succeeds. That is a delay, not a correctness problem.
- **A line larger than any single Warehouse's Available is a Shortage**, even when the Channel's Warehouses together hold enough. See #70. Transfers (#71), changing the default Warehouse (#72) and richer placement rules (#73) are follow-ups too.
- **Units in a Warehouse a Channel does not count are invisible to that Channel.** Its Orders never reserve there unless a person moves them.
