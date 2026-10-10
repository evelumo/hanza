# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

A small commerce team that splits the work (confirmed 2026-10-10): someone in the warehouse who picks, packs and corrects Stock; someone in customer service who works the Order feed and resolves Orders that need attention; and an owner who connects Channels, sets prices and rules, and watches that synchronisation is healthy. Each person spends most of their time in their own part of the panel, on a desktop, for long stretches of the working day.

Secondary: the person who installs and operates a self-hosted Hanza, and contributors evaluating the architecture.

## Product Purpose

Hanza is an open-source (MIT), self-hosted e-commerce integration hub: one place for Orders, Products, Stock and Connections to marketplaces, shops, couriers and invoicing tools. The panel is where the team sees what was sold, what is still available and what needs a person's attention, and acts on it. Success is a team member finishing their part of the day's work (fulfil Orders, fix Shortages, link Offers, repair a failing Connection) without hunting for it.

## Positioning

An alternative to Base.com / BaseLinker that the seller runs on their own infrastructure. Hanza is the single authority for Stock and prices and sends them to Channels; each external system sits behind a replaceable connector with a defined contract.

## Operating Context

- Next.js App Router panel (`apps/web`) behind Better Auth; an organization is the tenant.
- Background work (sync, pushes, sign-in, privacy) runs in a separate worker, so results appear asynchronously and screens show the state of work in progress.
- The panel speaks English (default) and Polish; copy lives in `messages/{en,pl}.json` and is never hard-coded.
- Panel flows are covered by Playwright tests that locate by role and accessible name in English.

## Capabilities and Constraints

- Screens today: dashboard, Products (list, detail, new, Offers, Offer detail), Product families, Orders (feed, detail), Warehouses, Connections (list, new, detail, sign-in), Privacy, Settings (Order statuses), sign-in, sign-up, onboarding.
- Domain vocabulary is fixed by the glossaries in `CONTEXT-MAP.md` / `CONTEXT.md` (Order phase vs Order status, Offer, Channel, Connection, Reservation, Shortage, Buyer data).
- An Order has one of four fixed phases; an organization's Order statuses are coloured labels within a phase.
- Money is a decimal string plus ISO currency. Buyer data is sealed and may be erased.
- Roles and per-role permissions are not implemented: every member sees the whole panel.
- No real connectors yet: only simulated Test channels. An in-panel AI assistant is planned, not built.

## Brand Commitments

- Name: Hanza. Tagline in the README: "Your commerce operations, on your infrastructure."
- The panel UI is built on shadcn/ui (user decision, 2026-10-10).
- The panel follows the category standard for commerce admins rather than a distinctive visual world; its quality bar is Shopify Admin (user decision, 2026-10-10).

## Evidence on Hand

- The fake Channel seed (five Offers, four Orders) in `packages/connectors/fake/src/seed.ts` and the demo walkthrough in `docs/demo.md`.
- No customers, testimonials, benchmarks or pricing exist; do not invent them.

## Product Principles

- What needs a person comes first: attention items, Shortages and failing Connections outrank totals.
- Each role reaches its own work in one step and stays there.
- State is always legible: every background result says what happened, when, and what to do next.
- One vocabulary: the panel uses the glossary's terms exactly.

## Accessibility & Inclusion

Every control has an accessible name (the end-to-end flows depend on it); meaning is never carried by colour alone; the panel is fully keyboard-operable.
