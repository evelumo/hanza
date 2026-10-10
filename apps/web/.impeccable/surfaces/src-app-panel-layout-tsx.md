---
version: 1
slug: "src-app-panel-layout-tsx"
primary_target: "src/app/(panel)/layout.tsx"
related_targets: ["src/app/(auth)/layout.tsx","src/app/onboarding/page.tsx"]
---

# Panel (admin) surface brief

Scope: every authenticated panel screen under `src/app/(panel)`, plus sign-in, sign-up and onboarding. Visitor mode: Operate.

Audience and job: a small commerce team that splits the work (warehouse, customer service, owner); each member reaches their own queue in one step and stays there for long desktop sessions in daylight office or warehouse light. Light theme is the default; dark follows the system or the user's toggle.

Constraints: routes, server actions, tenant scoping and the EN/PL message catalogues stay; every control keeps an accessible name; no hard-coded copy.

Memorable moment: the dashboard opens on what needs a person, and Cmd/Ctrl+K reaches any screen or action from anywhere.

## Direction contract

THESIS: The commerce admin a Shopify-fluent team trusts on sight, where what needs a person leads every screen. It refuses the dashboard of vanity KPI cards.

OWN-WORLD: shadcn/ui in neutral grays: gray canvas, white bordered cards with 8px corners and a hairline shadow, near-black primary buttons, blue focus rings and links, Inter with tabular numerals, pill badges pairing a tone with an icon shape.

STORY: The visitor sees what waits for them, opens it in one click, finishes it, and sees the result recorded.

FIRST VIEWPORT: Collapsible left sidebar grouped by job (Sales, Catalogue, Stock, Channels, Organization) with the user menu at its foot; top bar with breadcrumbs and a Cmd+K command palette (the signature interaction). Dashboard body: a Needs attention list first, Orders by phase beside Connection health, recent activity below. Each page's primary action sits top-right in its header.

FORM: The category standard (canon), chosen by the user over the roll; quality bar Shopify Admin. Seed key eb313bb0.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Unresolved

- Roles and per-role navigation do not exist yet; the sidebar groups by job instead.
