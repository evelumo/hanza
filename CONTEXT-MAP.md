# Context Map

## Contexts

- [Commerce model](./packages/connector-sdk/CONTEXT.md): the canonical vocabulary every connector translates into and out of (Product, Order, Buyer, …)
- [Core](./packages/core/CONTEXT.md): how a tenant's Hanza talks to the outside world and records what happened, and how it protects Buyer data (Connection, Channel, Event, Erasure, Retention period)

## Relationships

- **Core → Commerce model**: Core stores and synchronises the things the Commerce model names; connectors only ever see the Commerce model, never Core.
