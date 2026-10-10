# Roadmap

Hanza is in **early development**. This page summarizes the direction in the [original Polish architecture plan](plan-architektury.html), while distinguishing implemented foundations from future work. It is not a release schedule or a commitment to dates. Specs, implementation progress and review live in [GitHub Issues](https://github.com/evelumo/hanza/issues).

## Implemented foundations

- Monorepo, CI, local infrastructure, dependency checks, agent guide, ADRs and domain glossaries.
- Authentication/onboarding and organization-scoped domain data.
- Products, Product families, Offers, Warehouses, Stock/Reservations, prices, Orders, phases/statuses and Connections.
- Background sync, Connection health, push rejections, shared request limits and core-owned OAuth token lifetime.
- Durable workflow primitives with PostgreSQL state, steps, timers and signals.
- Buyer data sealing, retention and erasure services.
- Shipments from an Order through a courier Connection: Labels, status tracking, cancelling, and a carrier pickup that ships the Order; an InPost connector tested on cassettes written from its documentation.
- English/Polish panel, fake connectors, conformance tests, recorded HTTP fixtures and local browser flows.

These foundations work with simulated Channels and a simulated Carrier. The one real connector, InPost, has not been run against a live account, and the SDK has not yet been validated by two real Channel connectors, and a workflow engine is not yet a user-facing automation builder.

## Planned milestones

| Milestone | Intended outcome | Current boundary |
| --- | --- | --- |
| Real connector validation | Allegro Order feed and Stock pushes, followed by WooCommerce, exercising one contract against two APIs | No real Channel connector is registered today |
| Connector authoring with AI agents | A third connector built from the recipe and conformance tests without changing the core | Skill/reference implementations exist; generator and third real connector are planned |
| Shipping and invoicing | More Carriers, tracking numbers sent to the Channel, courier pickup orders, and invoicing capabilities | Shipments work through InPost and the simulated Carrier; no invoicing connector or panel flow |
| Automations and product-facing AI | Rules across Orders, shipments and invoices; MCP server, in-panel assistant and mapping assistance | Workflow primitives exist; these product features are planned |
| Connector ecosystem | Community distribution, broader author documentation and wholesale feeds | Current registry is a manually maintained build-time package |

Other planned interfaces include a public REST API, connector scaffolding/auto-discovery and browser flows in CI. Do not assume commands or deployment automation exist until they appear in the repository.

## Propose work

Describe a specific seller workflow and its acceptance criteria in an issue. Prefer a complete, testable path over an abstract extension without a consumer. Changes to the SDK/canonical model, Stock semantics or other core contracts follow [the reviewed spec process](../CONTRIBUTING.md#decide-whether-a-spec-is-needed).

When work ships, update this page and the README, link the implementation PRs from its spec, and close the spec issue. Code/tests and ADRs then describe the implemented behaviour.
