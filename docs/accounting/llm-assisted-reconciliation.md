# LLM-assisted bank reconciliation

Status: shipped (Stage 3 follow-up). Backend service + 4 admin
endpoints + Reconciliation tab in the UI all live.

## Why this exists

Manual bank reconciliation is the single most-friction operation in
property-management accounting. Traditional rule engines (QuickBooks,
Xero) require staff to write regex-style patterns to auto-categorize
recurring transactions. Most staff don't write rules; they re-do the
same categorization decisions every month and burn hours.

The LLM-assisted approach: staff types a one-line natural-language
explanation of what a transaction is and how to handle similar future
ones; Claude converts that into a structured `match_rule` row with
the right pattern, target GL account, attribution, and confidence
score. Future transactions matching the rule auto-suggest a posting,
reducing the next reconciliation pass to one-tap confirmations.

This is a moat: existing PM systems can't do this because they don't
have multi-dimensional attribution data on journal lines. Breeze OS's
LLM call passes the org's chart of accounts, properties, units, and
existing rules — Claude produces context-aware rules, not just
merchant-name regex matches.

## Data model

Two existing tables (Stage 3 migration 0008) plus one column
(migration 0017):

- `match_rules` — the rule itself
  - `pattern_type` text — currently always `'composite'`
  - `pattern_payload` jsonb — see schema below
  - `target` jsonb — see schema below
  - `confidence_score` real (0–1)
  - `times_used` / `times_rejected` integer counters
  - `is_active` boolean — auto-set false after 3+ rejections (and
    rejections > uses)
  - `natural_language_description` text — **the user's original
    one-liner**, surfaced verbatim in the rules-management UI
  - `last_matched_at` timestamptz — for stale-rule reporting

- `match_candidates` — proposed matches awaiting human review
  - One per rule × bank_transaction match
  - `confidence_score`, `match_reason_codes` text[]
  - `status` enum: `auto_matched` | `pending_review` | `confirmed` |
    `rejected`
  - Partial unique index: only one `confirmed` candidate per
    bank_transaction

## Pattern shape

`pattern_payload` jsonb (composite type):

```json
{
  "merchant_keywords": ["walmart", "wal-mart"],
  "exclude_keywords":  ["return", "refund"],
  "amount_range_cents": [1000, 50000],
  "bank_account_ids":  ["uuid-of-bank-1", "uuid-of-bank-2"]
}
```

All four fields are optional. Match logic is AND across fields, OR
within `merchant_keywords` (any one keyword matching qualifies).
`exclude_keywords` short-circuits to non-match.

`target` jsonb:

```json
{
  "gl_account_code": "6072",
  "memo_template":   "Plumbing — {merchant} — {date}",
  "attribute_to": {
    "property_id": "uuid-or-null",
    "unit_id":     "uuid-or-null",
    "tenant_id":   "uuid-or-null",
    "vendor_id":   "uuid-or-null"
  }
}
```

`memo_template` placeholders: `{merchant}` `{amount}` `{date}` —
substituted at journal-entry creation time when a match is
confirmed.

## Rule generation prompt

`lib/accounting/ruleGenerator.js` calls Claude with a system prompt
that locks down the output shape, plus a user message containing:

- The bank transaction (amount, date, merchant, description, bank
  account)
- The user's natural-language one-liner verbatim
- The org's chart of accounts (top 80 by recency)
- A list of existing active rules (so Claude doesn't duplicate)

Output is forced to a strict JSON schema; the service validates it
before insertion (rejects invalid `gl_account_code`,
`initial_confidence` outside 0–1, etc.).

Default model: `claude-sonnet-4-6`. Override via
`RECON_LLM_MODEL` env var.

## Confidence ramp-up

Newly created rules start at the LLM-suggested confidence (typically
0.55–0.95). Auto-match gate is **per-org configurable** (migration
0018 adds two columns to `organizations`):

- `recon_auto_match_confidence` real, default 0.95
- `recon_auto_match_min_times_used` integer, default 5

A candidate is `auto_matched` (vs `pending_review`) iff
`confidence_score >= recon_auto_match_confidence AND
rule.times_used >= recon_auto_match_min_times_used`. Set either
to a more lenient value to ramp auto-trust faster (e.g. 0.85 / 3),
or stricter (e.g. 0.99 / 20) for high-stakes orgs. Set
`min_times_used = 0` to auto-match purely by confidence with no
trust-history requirement.

Read or update via `GET / POST /api/admin/recon-settings`.

Staff confirmation increments `times_used` + updates
`last_matched_at`. Rejection increments `times_rejected`. Auto-
disable triggers when `times_rejected ≥ 3 AND times_rejected >
times_used`.

## API surface

| Endpoint | Purpose |
|---|---|
| `GET /api/admin/list-pending-reconciliation` | bank_transactions with no `confirmed` candidate, plus any pending candidates per row |
| `POST /api/admin/explain-and-rule` | body: `{bank_transaction_id, one_liner}`. Calls Claude, inserts rule, applies it to the originating transaction. Returns the rule + the new candidate. |
| `POST /api/admin/match-candidate-action` | body: `{candidate_id, action: 'confirm'\|'reject'}`. Bumps stats + auto-disables on threshold. |
| `GET /api/admin/list-match-rules` | Rule-management endpoint. Returns every rule with stats + descriptions. |

## UI

New "Reconciliation" tab on the Accounting page. Per pending
transaction:

1. Header: merchant name, amount (with `−$X` for outflow / `+$X` for
   inflow), bank account, date.
2. Existing candidates from prior rule matches (one card each, with
   confidence, reason codes, Confirm / Reject buttons).
3. Natural-language input ("Tell me what this is, e.g. 'plumber for
   SLM units, all repairs'") + Categorize button.
4. After submission: a green confirmation showing the new rule's
   name, GL account, confidence, and the LLM's plain-English
   explanation. The newly-created candidate appears on refresh.

## Required env vars

- `ANTHROPIC_API_KEY` — required for `/api/admin/explain-and-rule`.
  Without it the endpoint returns 503. The chat backend already uses
  the same key so this is usually pre-set.
- `RECON_LLM_MODEL` — optional model override.

## Posting on confirm

`confirmMatchCandidate` posts a balanced two-line journal entry in
the same transaction that flips the candidate to `confirmed`:

- **Outflow** (Plaid amount > 0, money OUT of bank) → entry type
  `disbursement`. Debit the rule's `target.gl_account_code`
  (expense increases), credit the bank account's GL (asset
  decreases).
- **Inflow** (Plaid amount < 0, money IN to bank) → entry type
  `receipt`. Debit the bank GL, credit the target GL.

The memo template is substituted with `{merchant}` / `{amount}` /
`{date}` placeholders. Attribution from `target.attribute_to`
(property/unit/tenant/vendor) lands on the non-cash leg.
`source_table='bank_transactions'`, `source_id=<bank_transaction.id>`
so the entry can be traced back to its original transaction. The
new `journal_entries.id` is written back to
`match_candidates.journal_entry_id`.

The DB trigger validates balance + non-zero at the moment of
posting, so a malformed rule (e.g. missing target code) rolls back
the whole confirm — the candidate stays pending and the user sees
the error.

## Auto-match on Plaid sync

`/api/admin/plaid-sync-transactions` runs `runRulesAgainstTransaction`
inside the same transaction that inserts a freshly-pulled
bank_transaction. Every active rule is evaluated against the new
row; matches become `match_candidates` (status `pending_review`,
or `auto_matched` if confidence ≥ 0.95 AND the rule's `times_used
> 5`). The sync response includes a `auto_match_candidates_created`
counter per Plaid item.

## What's still missing (next iteration)

- Rule-management UI. Endpoints exist (`list-match-rules`); a
  Settings tab to edit / disable / delete is the next UI piece.
- Cluster-based suggestions ("you have 17 similar transactions —
  apply one rule to all?").

## Why this is a moat

- Natural-language input → no syntax barrier for staff.
- Structured output → rules are real DB rows, auditable, editable.
- Confidence ramp-up → rules earn auto-trust over time.
- Domain context (COA, properties, tenants, vendors) → rules can
  attribute correctly across multiple dimensions, not just by
  merchant name.

The fourth point is the differentiator. Existing platforms can
match merchants but they can't say "Walmart purchases at SLM
properties during turnover periods → Repairs Supplies, attributed
to whichever unit the work order references." That requires
knowing the org's full structure, which Breeze OS gives Claude in
every prompt.
