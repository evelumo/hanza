# Organizations define Order statuses as labels within the fixed Order phases

Status: amends ADR 0003 (its first consequence)

Sellers want their own fulfilment workflow ("Waiting for packaging", "Delivered"), but Reservations, Stock consumption, Channel facts, Needs attention and the status push all depend on a small fixed list (issue #1). We decided that list becomes the **Order phases**, unchanged, and that an organization defines **Order statuses** as records that each belong to exactly one phase; every phase has a default status, created on first use. The core only ever reasons about the phase: a move within a phase changes the label and records an Event, nothing else (no Stock effect, nothing sent to the Channel, #29's pending-push mark untouched), while a change of phase follows ADR 0003 exactly. Connectors and the SDK keep speaking phases, so the connector contract does not change.

## Decisions within it

- **Storage.** `order.phase` (the old `status` column, renamed) stays the source of truth; `order.statusId` sits next to it with a composite foreign key `(organizationId, phase, statusId) → order_status(organizationId, phase, id)`, so the database refuses a status of another organization or another phase. A status's organization, phase and id never change.
- **Locking.** The only non-partial unique index on `order_status` covers those immutable columns; one default per phase and unique active names are partial indexes. Postgres treats columns of non-partial unique indexes as key columns, and updating one would lock the row `FOR UPDATE` and wait behind every Order import holding `FOR KEY SHARE` on it. Writers that give an Order a status lock it `FOR KEY SHARE` while reading it, so a status deleted meanwhile is skipped instead of failing the write.
- **Transitions.** A person may move an Order to any active status of the same phase (in every phase, final ones included) or of a phase ADR 0003 allows. An import or a Channel fact uses the Connection's **Status mapping** for that phase if it names an active status, otherwise the phase default. No per-status rules.
- **Names.** A default status has no name until a person gives it one, and is shown as the phase's name in each person's language: there is no organization locale, and defaults are created by the migration and by the worker.
- **Deleting.** A default status cannot be deleted. A status in use needs an active replacement of the same phase: it is deactivated and its mappings move at once, then the worker moves its Orders in batches (`orderStatuses.delete`) and deletes it. A lost enqueue (ADR 0010) leaves an inactive status that deleting again finishes.
- **History.** Events store the status id and its name at the time, next to the phases, so renaming never rewrites history.

## Considered options

- Statuses as free data with no phase: the core would need per-status Stock semantics, and every connector a mapping table; both are larger and riskier.
- Status mapping of raw Channel-native statuses as data: changes the SDK contract (connectors would return the Channel's own status); left for later (issue #76).
- A JSON mapping on the Connection: no foreign key, so a deleted or foreign status could be referenced.

## Consequences

- An organization that never opens the settings sees the same four statuses as before, in its own language.
- Channels never learn the finer statuses, only phase changes.
- Custom transition rules and per-status permissions (#75), automations and notifications (#77) and Stock behaviour tied to a status (#78) are follow-ups; the SDK still calls the phase `OrderStatus` (#79).
