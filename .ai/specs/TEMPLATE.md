# <Title>

- **Status:** draft <!-- draft | accepted | implemented | rejected | superseded by <file> -->
- **Date:** YYYY-MM-DD
- **Author:** <name or agent>
- **Related:** <links to other specs, issues, PRs>

## Summary

One paragraph: what changes and why it matters.

## Problem

What is wrong or missing today? Who is affected (merchant, connector author, operator)? Include constraints and non-goals.

## Proposed design

The approach, in enough detail to implement. Name the packages and files involved (`packages/core/src/...`). Describe flows (panel → queue → worker → connector), failure modes, idempotency and retries. Mention alternatives considered and why they were dropped.

## Data model changes

New or changed Prisma models (which `schema/*.prisma` file), indexes, constraints, and the migration. Every tenant-owned table carries `organizationId`. Write "None" if there are no changes.

## API / SDK contract changes

Changes to the Connector SDK (`defineConnector`, `Capabilities`, canonical zod schemas), job payloads, HTTP routes or server actions. Note what breaks for existing connectors and how they migrate. Write "None" if there are no changes.

## Tenant & security considerations

How data stays scoped by `organizationId`. Secrets and tokens (storage, logging), personal data, authorization, input validation, rate limits and abuse cases.

## Test plan

Unit and contract tests (Vitest), fixtures to record, edge cases (duplicates, retries, partial failures, concurrent stock updates), and anything verified manually.

## Rollout / migration

Order of deployment (migration, worker, web), backfills, feature flags, backwards compatibility, rollback plan.

## Open questions

- [ ] Question, with the owner who can answer it.

## Changelog

- YYYY-MM-DD: initial draft.
