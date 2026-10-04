# Hanza is the only source of truth for Stock

A seller's stock could live in Hanza, in their shop (with Hanza relaying it to marketplaces), or in either depending on the organization. We decided that Hanza owns Stock and every Channel — shops included — only receives it; importing products from a shop is a one-time seeding of the catalogue. Two sources of truth mean races that sell goods that do not exist, and a per-organization choice would double the sync engine.

## Consequences

- A seller who keeps editing stock in their shop's admin will have it overwritten by Hanza.
- Stock sync is one-directional (Hanza → Channel); there is no "pull stock" capability.
