# Breeze OS Accounting — Data Model (Foundation: GL + AR + Bank)

Status: draft, in active iteration.
Scope: Stages 0–3 of the staged delivery in `architecture.md`. AP,
payments adapters, owner-statement, and reporting tables are stubbed
here and fleshed out as we reach each stage.

This document is the **canonical column-level reference**. The Drizzle
schema files under `lib/db/schema/accounting/` implement it. If they
diverge, this doc is the source of truth and the schema is wrong.

## Conventions

- Every table has `id uuid PK`, `organization_id uuid NOT NULL`,
  `created_at`, `updated_at` (these are listed once at the top of each
  table and not repeated in the field tables below).
- Every monetary value is stored as **integer cents** (no `numeric`,
  no floats). Display formatting happens at the edge. Column type
  `bigint` to avoid 32-bit overflow on large aggregates.
- All dates are `timestamptz` unless otherwise noted. Period boundaries
  (which need calendar dates, not timestamps) use `date`.
- "Reserved for trust accounting v2" columns are listed in each table
  with a `(trust)` tag and are nullable in v1. The architecture doc
  commits to never breaking these out into a separate table.
- All foreign keys carry an explicit `ON DELETE` rule. The default is
  `RESTRICT` for accounting integrity — deletions must go through the
  service layer, which reverses postings rather than dropping rows.
- Every table has a `notes text` column for staff annotations. Free-form
  but indexed for trigram search where useful (TBD per table).

## Entity overview

```
                 organizations
                       │
        ┌──────────────┼───────────────┐
        ▼              ▼               ▼
     owners        properties      gl_accounts    accounting_periods
        │              │               │                  │
        │              ▼               │                  │
        │           units              │                  │
        │              │               │                  │
        │              ▼               │                  │
        │           leases             │                  │
        │              │               │                  │
        │      ┌───────┴──────┐        │                  │
        │      ▼              ▼        │                  │
        │ scheduled_     posted_       │                  │
        │ charges       charges        │                  │
        │      │              │        │                  │
        │      └──────┬───────┘        │                  │
        │             │                │                  │
        │             ▼                ▼                  │
        │         receipts ──▶ journal_entries ◀──────────┘
        │                            │
        │                            ▼
        │                     journal_lines ────┐
        │                            │           │
        │                            │           ▼
        ▼                            │      (beneficiary attr,
   (vendors, bills,                  │       unit/property/entity
    AP — stage 5+)                   │       attribution)
                                     ▼
                              bank_accounts
                                     │
                                     ▼
                              bank_transactions
                                     │
                                     ▼
                              match_candidates
```

## Section 1 — GL Core (Stage 1)

### `gl_accounts` — chart of accounts

Every journal line references one of these. This is THE chart-of-
accounts table.

| Column | Type | Notes |
|---|---|---|
| `code` | `text NOT NULL` | "1010", "4010" — unique per org. Free-form text so we can support gapped numbering. |
| `name` | `text NOT NULL` | "Cash - Operating", "Rent Income" |
| `account_type` | `gl_account_type` enum | `asset` \| `liability` \| `equity` \| `income` \| `expense` |
| `account_subtype` | `text` | Free-form for now: `cash`, `accounts_receivable`, `security_deposits_held`, `rent_income`, `repairs_maintenance`, etc. Becomes an enum once stable. |
| `normal_balance` | `gl_normal_balance` enum | `debit` \| `credit`. Derived from `account_type` but stored explicitly to keep posting code simple. |
| `parent_id` | `uuid NULL` | Self-FK for hierarchical accounts ("1000 Current Assets" → "1010 Cash"). Reporting rolls up the tree. |
| `is_active` | `boolean DEFAULT true` | Soft-disable. We never delete GL accounts — they may have historical postings. |
| `is_system` | `boolean DEFAULT false` | True for accounts the platform requires (Cash, AR, AP, Suspense, Rent Income, etc.). Cannot be deleted, only renamed. |
| `is_bank` | `boolean DEFAULT false` | True iff this is the cash GL account paired 1:1 with a `bank_account`. Maintained by trigger when `bank_accounts.gl_account_id` is set. |
| `currency` | `text DEFAULT 'USD'` | Reserved for multi-currency v2. Constraint: `'USD'` only in v1. |
| `notes` | `text` | |

Indexes: `UNIQUE(organization_id, code)`, `(organization_id, account_type)`.

Reserved columns:
- `is_trust boolean DEFAULT false` (trust) — `true` for cash GL accounts paired with `bank_account.is_trust=true`. Allows reporting to filter trust-only.
- `trust_purpose text NULL` (trust) — `null` \| `'general_trust'` \| `'security_deposit_trust'` \| `'tax_escrow'`. Determines which sub-ledger applies.

### `accounting_periods` — open/closed months

| Column | Type | Notes |
|---|---|---|
| `period_start` | `date NOT NULL` | First day of the period (usually month-start). |
| `period_end` | `date NOT NULL` | Last day of the period (usually month-end). |
| `fiscal_year` | `integer NOT NULL` | E.g. 2026. |
| `status` | `accounting_period_status` enum | `open` \| `soft_closed` \| `hard_closed`. Posting to a `hard_closed` period is rejected. `soft_closed` is staff-only override. |
| `closed_at` | `timestamptz NULL` | When the period was closed. |
| `closed_by_user_id` | `uuid NULL FK users` | |
| `notes` | `text` | |

Indexes: `UNIQUE(organization_id, period_start, period_end)`,
`(organization_id, status)`.

Why this exists v1: reporting reliability. If books can be changed
retroactively, every report you ever generated is wrong. Closing
periods is non-negotiable for any system that pretends to be accounting.

### `journal_entries` — header table

One row per business event that moves money or changes balances. The
posting rule from `architecture.md`: every monetary action becomes a
journal entry.

| Column | Type | Notes |
|---|---|---|
| `entry_number` | `bigint NOT NULL` | Monotonically increasing per org. Sequence-backed. Displayed to humans. |
| `entry_date` | `date NOT NULL` | The accounting date (NOT created_at — different on backdated entries). Used to determine which period the entry posts to. |
| `period_id` | `uuid NOT NULL FK accounting_periods` | Set at posting time. CHECK constraint: period must be `open` at the time of posting. |
| `entry_type` | `journal_entry_type` enum | `receipt` \| `disbursement` \| `bill` \| `bill_payment` \| `recurring_charge_posting` \| `adjustment` \| `transfer` \| `opening_balance` \| `period_close` |
| `source_table` | `text NULL` | If this entry was generated by another table (e.g. `'receipts'`, `'bills'`), the source table name. Audit trail. |
| `source_id` | `uuid NULL` | Row in the source table. |
| `memo` | `text` | Free-form description. Surfaced in reports. |
| `status` | `journal_entry_status` enum | `draft` \| `posted` \| `reversed`. Only `posted` rows affect balances. |
| `posted_at` | `timestamptz NULL` | When transitioned from draft → posted. |
| `posted_by_user_id` | `uuid NULL FK users` | |
| `reversed_by_entry_id` | `uuid NULL FK journal_entries` | If this entry was reversed, points to the reversing entry. Mutually exclusive with `reverses_entry_id`. |
| `reverses_entry_id` | `uuid NULL FK journal_entries` | If this entry IS a reversal, points to the original. |
| `notes` | `text` | Staff notes (separate from `memo`). |

Indexes: `UNIQUE(organization_id, entry_number)`,
`(organization_id, entry_date)`, `(organization_id, period_id)`,
`(source_table, source_id)`.

Constraints:
- `status='posted'` ⇒ `posted_at IS NOT NULL` (CHECK).
- A draft entry can be edited; a posted entry cannot — corrections go
  through reversal + re-post.

### `journal_lines` — the actual debits and credits

Every line is either a debit or a credit (not both). Stored as two
separate columns rather than a single signed amount because that's the
accounting convention and it makes constraints easier to write.

| Column | Type | Notes |
|---|---|---|
| `journal_entry_id` | `uuid NOT NULL FK journal_entries` | `ON DELETE CASCADE` only when the parent entry is `draft`; otherwise `RESTRICT` (enforced in service layer; FK is `RESTRICT` at the DB). |
| `gl_account_id` | `uuid NOT NULL FK gl_accounts` | `ON DELETE RESTRICT`. |
| `debit_cents` | `bigint NOT NULL DEFAULT 0` | Non-negative. |
| `credit_cents` | `bigint NOT NULL DEFAULT 0` | Non-negative. |
| `line_number` | `integer NOT NULL` | 1-indexed display order within the entry. |
| `memo` | `text` | Line-specific description; falls back to the entry's `memo` if null. |
| **Attribution chain — pick the most specific known** | | |
| `unit_id` | `uuid NULL FK units` | The unit this line is attributable to. |
| `property_id` | `uuid NULL FK properties` | The property — populated automatically when `unit_id` is set (denormalized for reporting speed). |
| `owner_id` | `uuid NULL FK owners` | The owner LLC — populated automatically. |
| **Domain attribution** | | |
| `lease_id` | `uuid NULL FK leases` | If this line relates to a specific lease (rent, late fee, security deposit). |
| `tenant_id` | `uuid NULL FK tenants` | If the line relates to a specific tenant. |
| `vendor_id` | `uuid NULL FK vendors` | Stage 5+. Reserved column. |
| **Trust accounting reserved fields** | | |
| `beneficiary_type` | `text NULL` (trust) | `'owner'` \| `'tenant'` \| `'vendor'` — required when the entry touches a trust GL account, ignored otherwise. |
| `beneficiary_id` | `uuid NULL` (trust) | The owner/tenant/vendor row this dollar belongs to. CHECK: required iff GL account is_trust=true. (Constraint added with trust v2.) |

Indexes:
- `(organization_id, gl_account_id, journal_entry_id)` — the index that
  drives every balance-as-of-date query.
- `(organization_id, unit_id)` — unit-level reporting.
- `(organization_id, property_id)`.
- `(organization_id, lease_id)`.
- `(organization_id, tenant_id)`.

Constraints:
- `CHECK ((debit_cents = 0) <> (credit_cents = 0))` — exactly one side is non-zero.
- `CHECK (debit_cents >= 0 AND credit_cents >= 0)`.
- **Entry-level balanced constraint:** sum of debits = sum of credits across all lines in a journal entry. Enforced via:
  - A `BEFORE INSERT/UPDATE` trigger on `journal_entries` when transitioning to `posted`, OR
  - A deferrable constraint plus a stored procedure that posts entries atomically.
  - Pick at implementation time. Trigger is simpler; deferrable constraint is more elegant. Both work.

Why two amount columns instead of one signed: the trigger that
enforces `SUM(debits) = SUM(credits)` becomes `SUM(debit_cents) -
SUM(credit_cents) = 0`, which is trivial. With a signed column the
constraint is the same but the column semantics conflict with the
debit/credit terminology everyone speaks.

## Section 2 — AR (Stage 2)

### `leases`

| Column | Type | Notes |
|---|---|---|
| `unit_id` | `uuid NOT NULL FK units` | Lease attaches to a unit, not a property. |
| `lease_number` | `text NOT NULL` | Human-readable identifier. Unique per org. |
| `status` | `lease_status` enum | `draft` \| `active` \| `notice_given` \| `ended` \| `evicted` |
| `start_date` | `date NOT NULL` | |
| `end_date` | `date NULL` | Null for month-to-month. |
| `rent_cents` | `bigint NOT NULL` | Current monthly rent. Changes via `lease_rent_changes` (audit log). |
| `rent_due_day` | `integer NOT NULL DEFAULT 1` | Day of month rent is due. |
| `late_fee_cents` | `bigint NULL` | Override; falls back to property/org default if null. |
| `late_fee_grace_days` | `integer NULL` | Override. |
| `security_deposit_cents` | `bigint NOT NULL DEFAULT 0` | Posted as a liability on the books when collected. |
| `source_lease_id` | `text NULL` | AppFolio lease ID during migration. |
| `source_pms` | `text NOT NULL DEFAULT 'appfolio'` | |
| `notes` | `text` | |

Linked tables (one row each):
- `lease_tenants` — many-to-many between `leases` and `tenants`, with `role` (primary, co-signer, occupant). One lease can have multiple tenants jointly and severally liable.
- `lease_rent_changes` — audit log of every change to `rent_cents` with effective date.

Indexes: `(organization_id, status)`, `(unit_id)`, `(source_lease_id)`.

### `tenants`

Lightweight — most contact details live in a future `contacts` or
`parties` table once the AR module is real. For now:

| Column | Type | Notes |
|---|---|---|
| `first_name` | `text` | |
| `last_name` | `text` | |
| `display_name` | `text NOT NULL` | Cached "First Last" for queries. |
| `email` | `text` | |
| `phone` | `text` | E.164 |
| `mobile_phone` | `text` | E.164 |
| `source_tenant_id` | `text` | AppFolio tenant ID. |
| `source_pms` | `text NOT NULL DEFAULT 'appfolio'` | |
| `notes` | `text` | |

Indexes: `(organization_id)`, `(source_tenant_id)`, `(email)`.

### `scheduled_charges` — forward-looking, anticipatory

A scheduled charge is a recurring obligation that will become a posted
charge on its due date. This is the table that makes anticipatory bills
and cash-flow forecasts work.

| Column | Type | Notes |
|---|---|---|
| `lease_id` | `uuid NULL FK leases` | Most scheduled charges belong to a lease (rent, recurring fees). Null is allowed for property-wide or owner-level recurrences (e.g. monthly insurance allocation). |
| `unit_id` | `uuid NULL FK units` | Required if lease_id null and the charge is unit-level. |
| `property_id` | `uuid NULL FK properties` | Property-level fallback. |
| `charge_type` | `text NOT NULL` | `rent` \| `late_fee` \| `utility_billback` \| `pet_rent` \| `parking` \| `other`. Free-form for v1; enum once stable. |
| `description` | `text NOT NULL` | |
| `amount_cents` | `bigint NOT NULL` | |
| `gl_account_id` | `uuid NOT NULL FK gl_accounts` | Income account this will credit. |
| `frequency` | `charge_frequency` enum | `monthly` \| `quarterly` \| `annual` \| `one_time` |
| `next_due_date` | `date NOT NULL` | When the next instance posts. Cron picks rows where `next_due_date <= today AND status='active'`. |
| `end_date` | `date NULL` | When the recurrence stops. Null = open-ended. |
| `status` | `scheduled_charge_status` enum | `active` \| `paused` \| `ended` |
| `notes` | `text` | |

Indexes: `(organization_id, next_due_date, status)`,
`(lease_id)`, `(unit_id)`, `(property_id)`.

### `posted_charges` — receivables on the books

When a scheduled charge fires, OR when staff posts an ad-hoc charge,
a `posted_charges` row is created AND a journal entry is posted:

    Dr  AR (1200)              $rent
        Cr  Rent Income (4010)         $rent

| Column | Type | Notes |
|---|---|---|
| `scheduled_charge_id` | `uuid NULL FK scheduled_charges` | Set if generated from a recurring schedule. Null for ad-hoc. |
| `lease_id` | `uuid NULL FK leases` | |
| `unit_id` | `uuid NULL FK units` | |
| `property_id` | `uuid NULL FK properties` | |
| `tenant_id` | `uuid NULL FK tenants` | The tenant whose ledger this charge sits on. |
| `charge_type` | `text NOT NULL` | Same vocabulary as `scheduled_charges`. |
| `description` | `text NOT NULL` | |
| `charge_date` | `date NOT NULL` | The date for accounting purposes. |
| `due_date` | `date NOT NULL` | |
| `amount_cents` | `bigint NOT NULL` | |
| `balance_cents` | `bigint NOT NULL` | Remaining open balance. Decreases as receipts apply against it. Hit zero = paid. |
| `gl_account_id` | `uuid NOT NULL FK gl_accounts` | Income account credited. |
| `journal_entry_id` | `uuid NOT NULL FK journal_entries` | The JE that created this charge. |
| `status` | `posted_charge_status` enum | `open` \| `partially_paid` \| `paid` \| `voided` |
| `notes` | `text` | |

Indexes: `(organization_id, status, due_date)`,
`(lease_id)`, `(tenant_id)`, `(unit_id)`, `(scheduled_charge_id)`.

### `receipts` and `receipt_allocations`

A receipt is "money in." Allocations link a single receipt to one or
more `posted_charges` it pays down. A receipt does NOT directly hit a
bank account — it sits in **Undeposited Funds** until it's bundled into
a `deposit` and the deposit clears.

`receipts`:

| Column | Type | Notes |
|---|---|---|
| `tenant_id` | `uuid NULL FK tenants` | Most receipts have a tenant. Some don't (owner contribution, refund return, Section 8 omnibus). |
| `lease_id` | `uuid NULL FK leases` | The lease this receipt is associated with (if any). |
| `received_date` | `date NOT NULL` | When we accepted the payment, not when it deposits. |
| `amount_cents` | `bigint NOT NULL` | |
| `payment_method` | `payment_method` enum | `ach` \| `check` \| `credit_card` \| `cash` \| `money_order` \| `paynearme` \| `section_8` \| `other` |
| `external_reference` | `text` | Check number, PayNearMe receipt id, Plaid txn id, Section 8 voucher number, etc. |
| `deposit_id` | `uuid NULL FK deposits` | Set when this receipt is included in a deposit. Null = still in undeposited funds. |
| `journal_entry_id` | `uuid NOT NULL FK journal_entries` | The JE that recorded this receipt: Dr Undeposited Funds, Cr AR (or Cr Tenant Credit if unallocated). |
| `status` | `receipt_status` enum | `pending` \| `cleared` \| `nsf_returned` \| `voided` |
| `notes` | `text` | |

`receipt_allocations`:

| Column | Type | Notes |
|---|---|---|
| `receipt_id` | `uuid NOT NULL FK receipts` | |
| `posted_charge_id` | `uuid NOT NULL FK posted_charges` | |
| `amount_cents` | `bigint NOT NULL` | Portion of the receipt applied to this charge. |

Why this shape: a tenant pays $2,150 which covers $2,100 rent + $50
late fee. Two `posted_charges` rows, one `receipt`, two
`receipt_allocations` rows. The receipt's amount = sum of its
allocations. Constraint enforced via trigger.

Unallocated receipts sit in a `prepaid_rent` or `tenant_credit` GL
account until allocated. The journal entry handles that automatically.

Indexes on receipts: `(organization_id, received_date)`,
`(tenant_id)`, `(lease_id)`, `(deposit_id)`,
`(external_reference)`.

Indexes on receipt_allocations: `(receipt_id)`, `(posted_charge_id)`.

### `deposits` and `deposit_items`

A deposit bundles one or more receipts that physically (or via ACH
batch) land in a bank account together. This is what makes check-
scanner batches, Section 8 omnibus payments, and ACH settlement
batches work cleanly.

The flow:

1. Receipt arrives → JE: `Dr Undeposited Funds, Cr AR (or Tenant Credit)`.
2. Receipt sits in undeposited funds (its `deposit_id` is null).
3. Staff scans a stack of checks (or an omnibus ACH lands) →
   `deposits` row created, several `deposit_items` rows link receipts
   to the deposit, `receipts.deposit_id` set.
4. Deposit posts → JE: `Dr Cash (bank GL), Cr Undeposited Funds`.
5. A `match_candidate` proposes pairing the deposit's JE with the
   `bank_transaction` Plaid sees when the money actually lands.

`deposits`:

| Column | Type | Notes |
|---|---|---|
| `bank_account_id` | `uuid NOT NULL FK bank_accounts` | Where the deposit lands. |
| `deposit_date` | `date NOT NULL` | The date the deposit hits the bank (or is expected to). |
| `amount_cents` | `bigint NOT NULL` | Must equal `SUM(deposit_items.amount_cents)`. Trigger-enforced. |
| `deposit_type` | `deposit_type` enum | `check_batch` \| `ach_batch` \| `cash` \| `wire` \| `section_8_omnibus` \| `other`. Free-form notes in `notes` if needed. |
| `external_reference` | `text` | Deposit slip number, ACH batch id, Section 8 batch id. |
| `journal_entry_id` | `uuid NOT NULL FK journal_entries` | The JE that posted the deposit. |
| `status` | `deposit_status` enum | `pending` \| `cleared` \| `nsf_returned` \| `voided`. `nsf_returned` cascades — receipts in the deposit revert to undeposited and their allocations reverse. |
| `notes` | `text` | |

`deposit_items`:

| Column | Type | Notes |
|---|---|---|
| `deposit_id` | `uuid NOT NULL FK deposits` | |
| `receipt_id` | `uuid NOT NULL FK receipts UNIQUE` | A receipt belongs to at most one deposit. UNIQUE enforces this. |
| `amount_cents` | `bigint NOT NULL` | Should match `receipts.amount_cents` in v1. Stored separately to allow partial-deposit edge cases later (e.g. a single oversize check split across two deposits — rare but legal). |

Indexes on deposits: `(organization_id, deposit_date)`,
`(bank_account_id, status)`, `(external_reference)`.

Indexes on deposit_items: `(deposit_id)`, `UNIQUE(receipt_id)`.

Constraints:
- Trigger: `deposits.amount_cents = SUM(deposit_items.amount_cents)`.
- Trigger: every receipt in a deposit must have
  `receipts.organization_id = deposits.organization_id` (tenancy
  isolation).
- Trigger: a receipt cannot be added to a deposit if its `status` is
  `voided` or `nsf_returned`.

Why this matters for **Section 8 specifically**: HUD/PHA sends one
ACH per month covering many tenants. That ACH is *one* deposit; the
allocations within it are *many* receipts (one per Section 8 tenant
voucher). Modeling this collapsed (AppFolio-style) makes the per-unit
attribution dance painful. Modeling it as deposit-of-many-receipts
keeps the unit ledger clean.

## Section 3 — Banking & Reconciliation (Stage 3)

### `bank_accounts`

The real-world banking object.

| Column | Type | Notes |
|---|---|---|
| `gl_account_id` | `uuid NOT NULL FK gl_accounts UNIQUE` | **1:1 enforcement.** |
| `display_name` | `text NOT NULL` | "Chase Operating ****1234" |
| `institution_name` | `text` | "JPMorgan Chase Bank, N.A." |
| `account_type` | `bank_account_type` enum | `checking` \| `savings` \| `money_market` |
| `routing_number_encrypted` | `text` | pgcrypto, same pattern as `owners.ein_encrypted`. |
| `account_number_encrypted` | `text` | pgcrypto. |
| `account_last4` | `text` | For display/disambiguation. |
| `current_balance_cents` | `bigint NULL` | Latest known balance per Plaid or manual entry. NOT the GL balance — those should match after recon. |
| `balance_as_of` | `timestamptz NULL` | When we last got a balance. |
| **Plaid integration** | | |
| `plaid_item_id` | `text NULL` | Plaid item ID (the link). |
| `plaid_account_id` | `text NULL` | Plaid account ID within the item. |
| `plaid_cursor` | `text NULL` | Transactions sync cursor for incremental updates. |
| `plaid_status` | `text` | `linked` \| `re_auth_required` \| `disconnected` |
| **Trust reserved** | | |
| `is_trust` | `boolean DEFAULT false` (trust) | |
| `trust_purpose` | `text NULL` (trust) | Mirror of `gl_accounts.trust_purpose`. |
| `notes` | `text` | |

Indexes: `(organization_id)`, `(plaid_item_id)`, `(plaid_account_id)`.

### `bank_transactions` — immutable raw feed

What Plaid sent us, or what staff manually imported from a statement.
Once ingested, this row never changes. Corrections happen via inverse
entries, not updates.

| Column | Type | Notes |
|---|---|---|
| `bank_account_id` | `uuid NOT NULL FK bank_accounts` | |
| `external_id` | `text NOT NULL` | Plaid transaction id, or `manual:<uuid>` for hand-entered. UNIQUE per bank_account. |
| `posted_date` | `date NOT NULL` | Date the bank shows the transaction. |
| `amount_cents` | `bigint NOT NULL` | Positive = money out of the account (debit), negative = money in (credit). Mirrors Plaid's sign convention. We will document the inversion explicitly in the service layer. |
| `description` | `text` | Raw bank memo. |
| `merchant_name` | `text` | Plaid-enriched merchant. |
| `pending` | `boolean DEFAULT false` | True for pre-clearing. Flips to false when the transaction posts. |
| `raw_payload` | `jsonb` | The full Plaid payload, for forensics. |
| `notes` | `text` | |

Indexes: `UNIQUE(bank_account_id, external_id)`,
`(organization_id, posted_date)`, `(bank_account_id, pending)`.

### `match_candidates` — fuzzy reconciliation queue

The bridge between bank reality and book reality.

| Column | Type | Notes |
|---|---|---|
| `bank_transaction_id` | `uuid NOT NULL FK bank_transactions` | |
| `journal_entry_id` | `uuid NULL FK journal_entries` | One side of the proposed match. Null if we have a bank transaction with no candidate yet (orphan). |
| `confidence_score` | `numeric(4,3)` | 0.000–1.000. Pluggable matching rules emit this. |
| `match_reason_codes` | `text[]` | `exact_amount`, `date_within_3d`, `tenant_name_match`, `learned_rule_id:xxx`. |
| `status` | `match_candidate_status` enum | `auto_matched` \| `pending_review` \| `confirmed` \| `rejected` |
| `confirmed_by_user_id` | `uuid NULL FK users` | Who confirmed/rejected. |
| `confirmed_at` | `timestamptz NULL` | |
| `notes` | `text` | |

Indexes: `(organization_id, status)`, `(bank_transaction_id)`,
`(journal_entry_id)`.

Constraints:
- Multiple `match_candidates` per `bank_transaction_id` is legal — a
  single deposit can match several JE candidates, and the reviewer
  picks. UI shows the candidates ranked by `confidence_score`.
- Only one `match_candidate` per `bank_transaction_id` can be
  `confirmed`. Partial UNIQUE INDEX enforces this.

### `match_rules` — learnable

Pattern-matching rules that improve over time. Initially staff-entered;
later, learned from confirmed matches.

| Column | Type | Notes |
|---|---|---|
| `name` | `text NOT NULL` | "Tenant Smith ACH" |
| `pattern_type` | `text` | `description_regex` \| `amount_exact` \| `amount_range` \| `merchant_name` \| `composite` |
| `pattern_payload` | `jsonb NOT NULL` | Per-pattern config. |
| `target` | `jsonb NOT NULL` | Where the match should route — `{tenant_id, gl_account_id, posted_charge_id?}` etc. |
| `confidence_score` | `numeric(4,3) NOT NULL` | What confidence to emit when this rule fires. |
| `times_used` | `integer DEFAULT 0` | Increments on confirmation. |
| `times_rejected` | `integer DEFAULT 0` | Increments on rejection. |
| `is_active` | `boolean DEFAULT true` | |
| `notes` | `text` | |

Indexes: `(organization_id, is_active)`.

## Section 4 — Stubs (later stages, not in foundation)

These are placeholders. Names locked in so foreign keys in the
foundation can point at them, but column-level schema lives in the
later-stage data-model addenda (`data-model-ap.md`, `data-model-
reporting.md` — not yet written).

- **`vendors`** — Stage 5. AP vendor master. Will hold TIN fields for
  eventual 1099 use even though 1099 generation is deprioritized.
- **`bills`** — Stage 5. Vendor invoices.
- **`scheduled_bills`** — Stage 5. Anticipated bills (recurring vendor
  invoices, utility bills, insurance, mortgage P&I). Mirrors
  `scheduled_charges`.
- **`posted_bills`** — Stage 5. Becomes a JE: Dr Expense, Cr AP.
- **`bill_payments`** — Stage 5. Pays down a bill, JE: Dr AP, Cr Cash.
- **`payment_provider_instances`** — Stage 4. Configured rail
  providers. Inbound (PayNearMe, Zego, Stripe), outbound (Modern
  Treasury, Plaid Transfer), and **Bill.com** for the
  charge-card / vendor-pay rail Breeze currently uses. Bill.com is
  dual-purpose — outbound AP and a transaction-feed source whose
  card/ACH activity needs to flow into `bank_transactions` (or a
  sibling `card_transactions` table, decision pending) for
  reconciliation. Stubbed; abstraction lives in
  `lib/backends/payments/`.
- **`ach_provider_instances`** — Stage 4. Modern Treasury / Plaid
  Transfer config (and Bill.com if used for outbound ACH).
- **`owner_statements`** — Stage 7. Generated per-owner monthly
  summary, snapshotted at generation time so historical statements
  don't change.
- **`reports_cache`** — Stage 7. Cached report runs.
- **`subscriptions`** — Stage 10+. Stub for SaaS productization.

## Section 5 — What v1 doesn't model (and why it's fine)

- **Per-tenant ledger as a separate table.** It's a view over
  `journal_lines WHERE tenant_id IS NOT NULL`. No need to materialize.
- **Sub-accounts beyond `parent_id`.** A two-level hierarchy is plenty
  for residential. Multi-level reporting works fine with recursive CTEs
  off `gl_accounts.parent_id`.
- **Custom fields.** Every table has a `notes` column; metadata can
  hang off there until we have a real need.
- **Multi-currency.** USD only. The `currency` column on `gl_accounts`
  is a placeholder; constraint enforces `'USD'` in v1.
- **Partitioning.** Not needed until `journal_lines` exceeds ~50M rows.
  Index strategy above is the bottleneck; partitioning is the relief.

## Settled design decisions

1. **Chart of accounts** — flexible per org. We will support both
   (a) shipping a default residential-PM template for new orgs, and
   (b) seeding from an org's existing AppFolio chart of accounts at
   migration time. The default template is hard-coded; the seeded
   version is a one-time import. **Constraint: the seeding/templating
   process MUST NOT auto-link bank-account-shaped GL accounts to real
   bank accounts.** Bank account linkage is always explicit, via the
   `bank_accounts.gl_account_id` UNIQUE FK. No magic.
2. **Undeposited funds** — modeled as a first-class concept. The
   `deposits` + `deposit_items` tables above implement this. AppFolio's
   collapsed model is explicitly rejected because it cannot represent
   check-scanner batches, ACH settlement batches, or Section 8 omnibus
   payments without losing per-receipt granularity.
3. **Period close cadence** — flexible per org. Schema does not
   assume monthly; `accounting_periods.period_start/end` can be any
   range. Default policy: monthly close, but the AI-driven near-
   real-time reconciliation goal lets us tighten to daily or
   3-day-trailing for orgs that want it. Pending bank transactions
   are the dominant slow-point and will gate aspirational cadences.
   This is a v1 goal, not a v1 deliverable.
4. **Backdated entries** — allowed into `open` periods, allowed into
   `soft_closed` periods only via an explicit user override that
   writes an `audit_events` row, forbidden in `hard_closed` periods.
   Reversal-and-repost is always allowed in any open period regardless
   of the original entry's period (this is how corrections work in
   accounting; you don't backdate, you reverse forward).

## Aspirational design goals (track, don't build yet)

- **Near-real-time reconciliation as a fraud control.** Three-way
  reconciliation that runs daily (or within 3 days, pending-aware)
  catches Okun-style trust-account schemes the day the books stop
  matching the bank. AI-assisted anomaly review on pending transactions
  is the bottleneck. Worth building as a deliberate Stage-3 capability
  rather than retrofitting later.
- **AppFolio chart-of-accounts importer.** Will need access to the
  AppFolio GL endpoints (currently blocked by IP allowlist) before this
  can be built.
- **Bill.com integration as a dual-purpose provider.** Outbound vendor
  pay and inbound card-transaction feed. Will need to decide
  `bank_transactions` vs `card_transactions` table separation when we
  get to Stage 4.
