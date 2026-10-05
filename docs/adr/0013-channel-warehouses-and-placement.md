# A Channel counts a set of Warehouses, a Reservation sits in one, and Warehouse rows join the lock order

Status: accepted. Amends ADR 0004 (lock order, Shortage) and ADR 0011 (what Reservations are checked against).

Sellers keep stock in several Warehouses and want each Channel to sell only from some of them (issue #4). We decided that each Channel counts either every active Warehouse (the default, including ones added later) or an explicit set of them. Available becomes per Warehouse: Stock minus open Reservations there. A Channel is told `channelAvailable` of the sum over its Warehouses, still computed only in `getChannelAvailability` (ADR 0011). A Reservation is placed whole in the first of the Order's Channel's Warehouses, in priority order (lower first, then id), whose Available covers the line. When none covers it, the line goes to the first Warehouse and is a Shortage. A person may move an open Reservation to any active Warehouse that covers it. In a one-Warehouse organization all of this reduces to the old rules exactly.

We chose this because a Channel must never be told more than its own Warehouses can fulfil. Judging an Order only against its Channel's Warehouses is what keeps the number it was told honest. A single priority list and no line splitting keep the rule simple, deterministic and easy to explain.

## Lock order

Every transaction takes its locks in this order and skips the steps it does not need:

1. the Order row (`lockOrder`, `FOR NO KEY UPDATE`);
2. the organization's Warehouse rows, `FOR SHARE`, in id order;
3. the Stock rows of the Products involved in those Warehouses, sorted by Product then Warehouse, after creating missing ones;
4. Offers, in id order.

`lockStock` does steps 2 and 3 in one call. It reads the Warehouses on the first call in a transaction only, and locks only Stock rows of Warehouses it has share-locked. Changing a Channel's Warehouses takes the Connection row (`FOR NO KEY UPDATE`), then step 2, then its choice rows, then step 4. Updating, deactivating or deleting a Warehouse takes only that one Warehouse row `FOR UPDATE`. After that it waits only for that Warehouse's own Stock rows, which only a holder of its share lock could have locked.

This cannot deadlock:

- Share locks do not conflict with each other.
- A Warehouse-management transaction holds a single lock and never waits on a row that a transaction blocked by it could hold.
- A Warehouse created during a transaction is never locked by it after a Stock row.
- No transaction takes a Connection lock after a Stock lock. An Order insert takes only KEY SHARE on its Connection, which does not conflict.

## Considered options

- Shortage judged against the sum over the Channel's Warehouses: rejected. A line could pass while no single Warehouse can ship it, because lines are not split.
- Per-Channel priority order: deferred to #73. One organization-wide order is enough to start.
- Locking the Connection row while reserving, so a concurrent change of its Warehouses waits: rejected. The choice is read without a lock and applies to the next Order. The Available it is checked against is still read under the Stock locks.
- Treating "no chosen Warehouses" as "all": rejected. Deleting the last chosen Warehouse would silently widen what the Channel is told.

## Consequences

- An inactive Warehouse holds no Stock and no open Reservations, and no Channel chose it. Deactivating and deleting are refused otherwise (the default Warehouse never), so neither changes any Available.
- A line larger than any single Warehouse's Available is a Shortage even when the Channel's Warehouses together hold enough. Splitting lines across Warehouses is issue #70. Transfers (#71), changing the default Warehouse (#72) and richer placement rules (#73) are follow-ups too.
- A Warehouse with negative Available (oversold) lowers what every Channel counting it is told, because those units are owed.
- Units in a Warehouse a Channel does not count are invisible to that Channel. Its Orders never reserve there unless a person moves them.
