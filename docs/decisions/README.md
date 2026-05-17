# Architecture decisions

This directory tracks decisions that shape the architecture of
Breeze OS — choices that future engineers (or future-you) will
need to understand the reasoning behind, not just the outcome.
Anything where "why did we do it this way?" is a fair question
six months from now belongs here.

## Format

Numbered, dated, status-tagged. One markdown file per decision:

```
0001-data-source-strategy.md
0002-appfolio-vs-breeze-data-ownership.md
0003-foo-bar-baz.md
...
```

Each file follows a light-weight ADR (Architecture Decision Record)
template:

```markdown
# NNNN. Short title

**Status:** Proposed | Accepted | Superseded by NNNN | Deprecated
**Date:** YYYY-MM-DD
**Deciders:** who signed off

## Context

What's the situation? What forces are in play? What are we
trying to solve?

## Decision

What we chose and the one-sentence summary of why.

## Consequences

What does this commit us to? What does it rule out? What new
work does it create?

## Alternatives considered

Brief — the options we looked at and why we didn't pick them.
```

## When to write one

- A choice that wasn't obvious, where the second-best option was
  also defensible.
- A choice that locks future work into a specific shape (data
  model, API contract, integration partner).
- A reversal — supersede the old ADR, don't delete it.
- Cross-cutting policy (auth, audit, retention, money handling).

## When NOT to write one

- Routine bug fixes.
- Cosmetic / UX polish.
- Anything where the commit message + code itself is self-explanatory.

## Index

| #     | Title                                                    | Status   |
|-------|----------------------------------------------------------|----------|
| 0001  | [Data-source strategy](./0001-data-source-strategy.md)   | Accepted |
| 0002  | [AppFolio vs Breeze data ownership](./0002-appfolio-vs-breeze-data-ownership.md) | Accepted |
| 0003  | [Cache vs source-of-truth labeling](./0003-cache-vs-source-of-truth-labeling.md) | Accepted |
| 0004  | [AI-summarized maintenance ticket titles](./0004-ai-summarized-ticket-titles.md) | Accepted (opt-in) |
| 0005  | [Daily summary briefing for owners and PMs](./0005-daily-summary-briefing.md) | Accepted (v1 shipped) |

## Cross-references

These docs aren't ADRs themselves but inform several decisions:

- [`docs/tenants-write-architecture.md`](../tenants-write-architecture.md)
  — concrete implementation sketch for the AppFolio-first write
  model recommended in ADR 0002.
- [`docs/plaid-integration-audit.md`](../plaid-integration-audit.md)
  — production readiness gates for the Plaid pipeline.
- [`docs/menu-audit.md`](../menu-audit.md) — current state of
  every page in the UI, including which data source backs it.
