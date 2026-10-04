# State tables are the truth; Events are a log beside them

We considered event sourcing (events as truth, tables as projections) because the system is integration-heavy and needs an audit trail and triggers for automations. We decided on ordinary state tables with an Event appended in the same transaction as the change it describes. That gives the audit trail and the triggers without projections, replay and event versioning — costs that would also make it much harder for contributors and AI agents to add modules.

## Consequences

- State cannot be rebuilt from Events; Events may be pruned or partitioned by age.
- Every write path that matters must append its Event in the same transaction.
