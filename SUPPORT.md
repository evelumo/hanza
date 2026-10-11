# Support and community

Hanza is in early development. Community support happens in [GitHub Issues](https://github.com/evelumo/hanza/issues); there is no published response-time commitment or dedicated hosted support service.

## Before opening an issue

Read the [quick start](docs/quick-start.md) and [troubleshooting](docs/quick-start.md#troubleshooting), then search existing issues. Shipments exist, with one real connector, InPost (a courier); real Channel connectors, invoicing, a public REST API and product-facing AI are planned; see the [roadmap](docs/roadmap.md).

## Report a bug

Include:

- The commit (`git rev-parse HEAD`), operating system, Node.js and pnpm versions.
- Exact reproduction steps and whether it happens with the Test channel.
- Expected and actual behaviour.
- Relevant sanitized web/worker output, screenshots or test traces.
- Whether Postgres, Redis and the worker were running, and any skipped tests.

Remove credentials, `.env` values, cookies and Buyer data from attachments. For an E2E failure, report the failing flow and the useful parts of its retained logs rather than uploading an unchecked results directory.

## Propose a feature or ask a question

Open an issue explaining the workflow you need, the current obstacle and the affected Channel or panel area. Keep the desired outcome separate from a suggested implementation. Larger changes follow [the spec process](CONTRIBUTING.md#decide-whether-a-spec-is-needed).

## Report a vulnerability

Follow [SECURITY.md](SECURITY.md) and report it privately.
