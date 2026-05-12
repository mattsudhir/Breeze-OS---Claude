# Breeze OS Accounting — Architecture

Status: draft, in active iteration.
Owner: this Claude session (branch `claude/breeze-os-planning-l0gdV`).

## Scope and intent

Breeze OS is becoming the system of record for property-management
accounting at Breeze Property Group, replacing AppFolio. The platform is
designed to be sold as SaaS to other PMs eventually, so every decision
that distinguishes "internal tool" from "product" is biased toward
product from day one.

Out of scope for v1:

- **Trust accounting** is not built initially, but every schema and
  service boundary is built so trust accounting is an additive feature
  (a flag, a sub-ledger, a few state-specific rules), not a rewrite.
- **Commercial leases** — residential only for v1. Commercial CAM
  reconciliation, percentage rent, and recoveries are deferred.
- **Multi-currency** — USD only.
- **Charging *our* SaaS customers** — a `subscriptions` stub will exist
  but no billing infra is built yet.
- **1099-MISC / 1099-NEC reporting** — deprioritized. The schema
  retains vendor TIN fields so we can layer reporting in later without
  a migration, but no 1099 generation in v1.
- **Money-movement *implementations*** — deprioritized. The provider
  abstractions (`PaymentProvider`, `AchProvider`) are built so v1 has
  the seams in the right place, but the only inbound provider wired up
  in v1 is a stub. PayNearMe / Modern Treasury / Plaid Transfer
  integrations come later behind the same interfaces.

## Source-of-truth strategy vs AppFolio

Breeze OS replaces AppFolio. During migration:

- One-way pull from AppFolio (existing `lib/backends/appfolio.js`)
  populates `source_pms='appfolio'` breadcrumb columns. No writes back.
- Per-property cutover: a property is either "live in Breeze" or "still
  in AppFolio." There is no dual-write period. Cutover state is tracked
  on the `properties` row.
- After cutover, AppFolio IDs remain in `source_*_id` columns as
  historical breadcrumbs only.

## Architectural layering

Each layer depends only on the ones below it. No upward dependencies.

```
┌─────────────────────────────────────────────────────────────┐
│  UI: /accounting (src/components/Accounting*.jsx)            │
├─────────────────────────────────────────────────────────────┤
│  Reporting & Statements                                      │
│    Owner statements · P&L · Cash flow · Rent roll · 1099     │
├──────────────────────────┬──────────────────────────────────┤
│  AR (Receivables)        │  AP (Payables)                   │
│    Leases · Charges      │   Vendors · Bills · Bill Pay     │
│    Recurring · Late fees │   Anticipated Bills              │
│    Receipts/Allocations  │                                  │
├──────────────────────────┴──────────────────────────────────┤
│  General Ledger                                              │
│    Chart of Accounts · Journal Entries · Periods             │
│    (Every AR/AP/Bank action posts journal entries here)      │
├─────────────────────────────────────────────────────────────┤
│  Bank / Reconciliation                                       │
│    bank_accounts · bank_transactions · match_candidates      │
│    (Plaid feeds in; bank_account separate from gl_account)   │
├─────────────────────────────────────────────────────────────┤
│  Money Movement Rails (abstracted)                           │
│    inbound: PayNearMe / Zego / Stripe (tenant payments)      │
│    outbound: Modern Treasury / Plaid Transfer (ACH out)      │
│    Identity/Auth: Plaid Identity + Auth                      │
│    All providers behind PaymentProvider / AchProvider        │
├─────────────────────────────────────────────────────────────┤
│  PMS Source Abstraction (existing — lib/backends/)           │
│    AppFolio (migration source only after cutover)            │
└─────────────────────────────────────────────────────────────┘
```

## Load-bearing commitments

These are the decisions that, if reversed later, force a rewrite. They
are non-negotiable for v1.

### 1. Every money-moving event posts a journal entry

A rent receipt is not "money in." It is a multi-line journal:

    Dr  1010 Cash — Operating         $2,150.00
        Cr  4010 Rent Income                  $2,100.00
        Cr  4020 Late Fee Income                  $50.00

A bill payment is:

    Dr  6010 Repairs & Maintenance     $487.50
        Cr  2010 Accounts Payable             $487.50

…and at payment time:

    Dr  2010 Accounts Payable          $487.50
        Cr  1010 Cash — Operating             $487.50

Why this matters: it is what makes reporting trivial later instead of
impossible. AppFolio's looser model is part of why its reporting is
rigid. Every reportable number in this system is derived from journal
lines, not from per-domain side tables.

### 2. `bank_account` and `gl_account` are different tables, 1:1 linked

- `gl_account` is "1010 — Cash, Operating." It lives in the chart of
  accounts and is what journal lines reference.
- `bank_account` is "Chase ****1234, Plaid item `xyz`, ABA `021000021`,
  account `1234567890`, current balance, last sync at." It is a
  real-world banking object.
- Each `bank_account` has a `gl_account_id` FK with a `UNIQUE`
  constraint — exactly one bank account per cash GL account. Sweeps,
  transfers between accounts, etc. are modeled as two GL accounts with
  a transfer journal entry, not as one GL fanning out.

Why two tables instead of one: GL accounts number in the dozens-to-
hundreds (income, expense, AR, AP, equity, etc.); bank accounts number
in single digits. Putting Plaid item IDs, routing numbers, balances,
and sync state on every GL row leaves 95% NULL. Lifecycle differs too
— GL accounts close at year-end, bank accounts come and go when banks
change.

Why this matters: trust accounting later is `bank_account.is_trust=true`
plus a beneficiary sub-ledger keyed off journal lines — additive, not a
rewrite. Each trust bank account gets its own segregated GL account,
which the 1:1 constraint already enforces.

### 3. Unit-level granularity throughout

Every charge, receipt, bill, and journal line that *can* be attributed
to a unit *is* attributed to a unit. The chain:

    journal_line.unit_id  (nullable)
              └── falls back to property_id
                          └── falls back to entity_id (the owner LLC)

The fallback chain handles common-area expenses, property-wide
insurance, owner-level legal fees, etc. without losing granularity for
the 95% of transactions that do belong to a unit.

This is the structural fix to AppFolio's property-level reporting limit.

### 4. Open API by construction

Every accounting mutation is reachable through the same versioned HTTP
API the eventual SaaS customers will use. There is no "internal-only"
endpoint that skips the public contract.

- Routes live under `api/v1/accounting/*`.
- Every endpoint has a Zod schema and an OpenAPI spec entry.
- The Breeze OS frontend calls the same endpoints external customers
  will call. No private shortcuts.

### 5. Strict org-boundary enforcement

`organization_id` is on every row. Every query goes through a service
layer that injects the org filter — direct table reads without it are a
lint error. This is cheap now and impossible to retrofit.

### 6. Fuzzy reconciliation as a first-class concept

Bank transactions and ledger entries don't have a 1:1 relationship. The
schema models:

- Raw bank transactions are immutable once ingested.
- A `match_candidate` row links bank transactions to ledger entries with
  a confidence score and a status (`auto_matched`, `pending_review`,
  `rejected`, `confirmed`).
- A single bank transaction can match many ledger lines (a single
  deposit covering multiple tenant payments) and vice versa.
- Match rules are versioned and learnable.

### 7. Anticipatory bills are a separate table from posted bills

`scheduled_charge` and `scheduled_bill` are forward-looking. They become
`posted_charge` / `posted_bill` (or journal entries directly) on their
due date via a cron. This gives free cash-flow forecasting for any unit,
property, or owner.

## Payments rail abstraction

There are two interfaces:

- `PaymentProvider` — inbound tenant payments. Implementations:
  PayNearMe (v1), Zego or Stripe (stub for v1, real for v2).
- `AchProvider` — outbound money movement (owner distributions, vendor
  bill pay). Implementations: Modern Treasury (primary), Plaid Transfer
  (secondary, for low-volume use cases that fit within Plaid Transfer's
  limits), Bill.com (currently used at Breeze for vendor pay + charge
  cards; gets wrapped behind this interface).

Plaid sits across both layers:

- **Plaid Transactions** — feeds `bank_transactions` for reconciliation.
- **Plaid Auth** — verifies tenant/owner routing+account before ACH.
- **Plaid Identity** — KYC at signup.
- **Plaid Transfer** — one possible implementation of `AchProvider` for
  cases where its limits ($100K/day default, no RTP, no wires) are
  acceptable.

Bill.com is dual-purpose: outbound AP rail AND an inbound transaction
feed (its card and ACH activity must reconcile against our books). The
transaction-feed side ingests into `bank_transactions` (or a sibling
`card_transactions` table — TBD at Stage 4) alongside Plaid's feed.

## Aspirational: near-real-time reconciliation

Industry norm is monthly reconciliation. With Plaid (and eventually
Bill.com) feeding transactions live and the match-candidate model
described above, three-way reconciliation can run daily — or, for
orgs that want it, on a 3-day-trailing window once pending
transactions clear.

This isn't just an efficiency play. Daily three-way reconciliation is
the structural defense against Okun-style fraud in fiduciary accounts:
the day the books stop matching the bank, the alarm fires. AI-assisted
review of pending transactions and exception queues is the human-in-
the-loop layer. Track this as a deliberate Stage-3 capability rather
than retrofitting it later.

## File ownership during parallel-session work

This session ("accounting session") owns:

| Path | Notes |
|---|---|
| `lib/db/schema/accounting.js` | new, after schema-split refactor |
| `lib/db/migrations/0006+_*.sql` | every new migration is accounting-related until the parallel session catches up |
| `src/components/Accounting*.jsx` | accounting UI only |
| `api/v1/accounting/**` | new directory tree |
| `api/accounting/**` | (legacy/internal) accounting endpoints if needed |
| `lib/accounting/**` | service layer |
| `lib/backends/payments/**` | new directory: payment + ACH provider adapters |
| `lib/backends/plaid.js` | new |
| `docs/accounting/**` | this doc lives here |

The parallel session ("non-accounting session") owns everything else.

Shared file: `lib/db/schema.js` gets refactored into a `lib/db/schema/`
directory with a re-exporting `index.js` in stage 0. After that, the
sessions edit different files in the same directory.

## Staged delivery

| Stage | Scope | Rough effort |
|---|---|---|
| 0 | Architecture doc + data-model doc + schema-split refactor | ~1 wk |
| 1 | GL core: chart of accounts, journal entries, periods | 6–8 wk |
| 2 | AR: leases, recurring charges, posted charges, receipts | 10–12 wk |
| 3 | Banking: bank_accounts, Plaid ingestion, fuzzy match queue | 8–10 wk |
| 4 | Payments rail: provider interface + PayNearMe + 1 stub | 8–10 wk |
| 5 | AP: vendors, bills, anticipated bills, bill pay | 10–12 wk |
| 6 | AppFolio one-way migration tooling | 6–8 wk |
| 7 | Reporting v1: owner statements, P&L, rent roll (no 1099) | 10–14 wk |
| 8 | UI buildout for /accounting end-to-end | 16–20 wk |
| 9 | Trust accounting | 8–12 wk |
| 10+ | Hardening, edge cases, multi-state, SaaS productization | rolling |

~2 PY MVP + ~3 PY polish/coverage ≈ 5 PY total at human-only effort. AI
augmentation compresses raw work to ~1.5–3 PY, but human review/decision
time remains the binding constraint: 8–12 weeks of focused review to
reach a demoable foundation (stages 0–3), 30–50 weeks over 12–18
calendar months to reach a system worth cutting over to (through stage
8). Going faster than that is possible but optimistic — most of the
slack is in real-world integration testing, not in writing code.

## Open decisions

These are deferred until they become blocking.

- **Frontend structure** — stay in the current Vite app or carve into a
  workspace? Decide when surface area is clearer (likely stage 8).
- **Payments rail v1** — PayNearMe is the v1 inbound. Second provider
  (Zego vs Stripe) chosen at stage 4.
- **ACH originator** — Modern Treasury is the working assumption.
  Confirm at stage 4 with a build-vs-buy review.
- **Auth/RBAC** — schema notes Clerk as the eventual auth layer. SaaS
  productization will need per-org RBAC beyond Clerk's defaults.
- **Reporting engine** — hand-rolled SQL vs a library (Cube, Metabase
  embed, etc.) decided at stage 7.
