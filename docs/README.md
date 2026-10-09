# Hanza documentation

Start with [the project README](../README.md) for the product, its current stage and the local setup.

## Use and operate Hanza

| Guide | What you will learn |
| --- | --- |
| [Quick start](quick-start.md) | Install dependencies, configure local services, start Hanza and troubleshoot setup |
| [Demo walkthrough](demo.md) | Try the full Offer → Product → Stock → Order path with a simulated Channel |
| [Self-hosting](self-hosting.md) | Run separate web/worker processes, preserve secrets and data, and apply upgrades |
| [Roadmap](roadmap.md) | Understand what exists and what is planned |
| [Support](../SUPPORT.md) | Report bugs and ask questions with useful evidence |
| [Security](../SECURITY.md) | Report vulnerabilities privately |

## Develop and extend Hanza

| Guide | What it covers |
| --- | --- |
| [Contributing](../CONTRIBUTING.md) | Issue/spec review, code conventions and PR expectations |
| [Development](development.md) | Workspace commands, configuration and common change paths |
| [Testing](testing.md) | Unit, database, Redis, conformance and browser test layers |
| [Architecture](architecture.md) | Dependency direction, data ownership and execution boundaries |
| [Connector guide](../packages/connectors/README.md) | Available reference connectors, capabilities and recorded HTTP fixtures |
| [Agent guide](../AGENTS.md) | Repository map, task router, approval gates and validation contract |
| [Domain map](../CONTEXT-MAP.md) | Canonical terms and context relationships |
| [ADRs](adr/) | Decisions and the trade-offs behind them |

## Where design records live

**Current behaviour** lives in code and tests. **Specs and review** live in [GitHub Issues](https://github.com/evelumo/hanza/issues), following [the issue tracker guide](agents/issue-tracker.md). **Decisions** live in ADRs; **vocabulary** in the domain glossaries.

The original [architecture plan](plan-architektury.html) is in Polish and contains future ideas as well as foundations. The [roadmap](roadmap.md) labels that distinction. Viewing the HTML plan locally is easiest by opening the file in a browser; GitHub's file view shows its source.

Repository engineering docs are in English. The panel supports English and Polish through its message catalogues, without locale prefixes in URLs.
