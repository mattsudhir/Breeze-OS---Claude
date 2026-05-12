# Breeze OS Accounting Platform — Project Status

Living document. Updated as work completes against the staged
delivery plan in `docs/accounting/architecture.md`.

## Project metadata

| Field | Value |
|---|---|
| **Start date** | 2026-05-11 |
| **Branch** | `claude/breeze-os-planning-l0gdV` |
| **PR** | [#3 (draft)](https://github.com/mattsudhir/Breeze-OS---Claude/pull/3) |
| **Owner** | Mat (50% co-owner of Breeze Property Group); co-piloted by Claude on the same repo |
| **Strategic goal** | Replace AppFolio as Breeze's accounting system of record; eventually productize as SaaS for other residential PMs |

## Method note

The architecture doc's effort estimates (5 PY total at human-only
pace) assume one engineer working full-time. This project is AI-
accelerated, so calendar progress per day is much faster than the
estimates imply, but the *human review/decision time* is the
binding constraint — that's the number the architecture doc
calibrates against ("8–12 weeks of focused review to reach a
demoable foundation").

Percent-complete below reports against the architectural plan, not
calendar days. AI-accelerated completion of "two weeks of work" in
one calendar day still counts as two weeks of architectural
progress.

## Stage completion vs. architecture.md plan

| Stage | Scope | Effort (PY est.) | Status | % |
|---|---|---|---|---|
| 0 | Architecture + data-model + schema-split refactor | ~1 wk | done | **100%** |
| 1 | GL core (accounts, periods, entries, lines, counters) | 6–8 wk | done | **100%** |
| 1.5 | COA seeder + AppFolio importer (Stage 6 work pulled forward) | 2–3 wk | done | **100%** |
| 1.6 | Multi-dimensional tagging design + vocabulary stubs + schema | ~1 wk | doc + stubs + schema landed | **80%** |
| 2 | AR (leases, tenants, scheduled/posted charges, receipts, deposits) | 10–12 wk | schema + migration + default tag rules landed; service-layer posting helpers pending | **35%** |
| 3 | Banking (bank_accounts, Plaid, fuzzy recon) | 8–10 wk | pending | 0% |
| 4 | Payments rail abstraction + 1 inbound provider | 8–10 wk | pending | 0% |
| 5 | AP (vendors, bills, anticipated bills, bill pay) | 10–12 wk | pending | 0% |
| 6 | AppFolio migration tooling (rest of it — JE / bill / receipt importers) | 6–8 wk | partial (COA done) | **20%** |
| 7 | Reporting v1 (owner statements, P&L, rent roll) | 10–14 wk | pending | 0% |
| 8 | UI buildout for /accounting end-to-end | 16–20 wk | pending | 0% |
| 9 | Trust accounting v2 | 8–12 wk | reserved-fields only | **5%** |

**Weighted overall: ~20%** of the architectural plan.

Caveat: this is the architectural completion against the planned
*scope*. Real production-readiness includes a lot of work that's not
in the architecture doc — observability, runbook coverage, SOC 2,
billing-of-our-SaaS-customers, etc. — so "100% architectural" is
more like "first usable internal version", not "shippable SaaS
product".

## What's landed on the branch so far (chronological)

1. `docs/accounting/architecture.md` — seven load-bearing
   commitments, file ownership for parallel-session work, staged
   delivery plan.
2. `docs/accounting/data-model.md` — column-level GL + AR + Bank
   foundation reference (~12 tables, trust fields reserved).
3. `lib/db/schema.js` → `lib/db/schema/` directory refactor
   (byte-equivalent split into 4 modules + `index.js`).
4. `lib/backends/appfolio.js` — Reports API v1+v2 support,
   GL/bills/receipts tools, separate-auth credential plumbing.
5. `api/admin/appfolio-introspect.js` + `appfolio-coa.js` — admin
   endpoints that pulled the live AppFolio data.
6. `docs/accounting/appfolio-access-setup.md` — Vercel + AppFolio
   IP allowlist + Reports API credential runbook.
7. `lib/db/schema/accounting.js` + `0006_accounting_gl_core.sql` —
   Stage 1: gl_accounts, accounting_periods, journal_entries,
   journal_lines, journal_entry_counters with USD CHECK, balanced-
   on-post trigger, and posted-line-immutability trigger.
8. `docs/accounting/appfolio-coa-analysis.md` — 254-account
   analysis of Breeze's live AppFolio chart, cutover remap rules,
   proposed 176-account Breeze OS default template.
9. `lib/accounting/defaultChartOfAccounts.js` + `seedChartOfAccounts.js`
   + `api/admin/seed-chart-of-accounts.js` — default COA seeder.
10. `lib/accounting/appfolioImportRules.js` + `importAppfolioCoa.js`
    + `api/admin/import-appfolio-coa.js` — cutover importer with
    dry-run mode + audit_events trail.
11. `docs/accounting/multi-dimensional-tagging.md` +
    `lib/accounting/tagVocabularies.js` — design doc and validation
    rules for the fact-and-dimensions tagging pattern that fixes
    AppFolio's "one classification per account" limitation.
12. Stage 2 schema landed: 12 new tables (tenants, leases,
    lease_tenants, lease_rent_changes, deposits, scheduled_charges,
    receipts, posted_charges, receipt_allocations, deposit_items,
    gl_account_tags, journal_line_tags) + 10 new enums.
    Migration `0007_accounting_ar.sql` with CHECK constraints
    on balance / amount integrity and four PL/pgSQL triggers for
    deposit & allocation sum integrity, voided-receipt rejection,
    and cross-org-reference defense. Retroactive journal_lines
    FKs to leases and tenants now wired.
13. `lib/accounting/defaultGlAccountTags.js` — 22 rules that
    automatically classify new GL accounts (cost_class /
    tax_treatment / functional / asset_category) at seed/import
    time. Applied to the 176-account default chart: 103 accounts
    pick up 235 default tags, zero unknown vocabulary refs.

## What's next

- **Stage 2 schema** (this PR): leases, tenants, lease_tenants,
  lease_rent_changes, scheduled_charges, posted_charges, receipts,
  receipt_allocations, deposits, deposit_items, plus the
  multi-dimensional tagging tables (gl_account_tags,
  journal_line_tags). Migration `0007_accounting_ar.sql`.
- **Service layer for AR posting**: helper functions that take a
  domain action (post a recurring rent charge, allocate a receipt
  against open charges, record a deposit batch) and emit the right
  journal entries with proper tag cascade.
- **Stage 3 schema**: bank_accounts table with the 1:1 UNIQUE FK
  to gl_accounts, Plaid integration columns, bank_transactions
  immutable feed, match_candidates fuzzy-recon queue.

## How to update this doc

When a stage completes (or a new substage gets meaningfully done),
update the table above and add the latest item to the chronological
list. Keep the % numbers honest — partial schema-only completion is
not 100%, since the AR module isn't done until the service layer
and at least one end-to-end happy-path test exists.
