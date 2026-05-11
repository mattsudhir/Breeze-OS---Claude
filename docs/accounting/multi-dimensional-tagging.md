# Multi-dimensional tagging on accounts and journal lines

Status: design doc. Schema implementation deferred to Stage 2 (AR) so
the tag tables land alongside the first transactional activity that
actually exercises them. Vocabularies are stubbed in code now so the
design is concrete and not just prose.

## Why this exists

A traditional chart of accounts answers exactly one question:

> Where does this dollar belong in the income-statement / balance-sheet
> hierarchy?

A typical property-management accountant or owner also needs to
answer, simultaneously and per-dollar:

- Is this an **operating** expense, a **one-time** charge, or a
  **capital** expense that should sit on the balance sheet and be
  depreciated?
- What's the **tax treatment** — ordinary deduction, Section 179,
  bonus depreciation candidate, capitalized under MACRS, or limited
  by passive-activity rules?
- For capitalized items: what **asset category** controls the
  depreciation schedule — building, land improvement, personal
  property (5-yr or 7-yr), or intangible?
- What was the **business context** — turnover, make-ready,
  emergency, routine, acquisition, disposition?
- For finer-grain reporting: what **functional** category — HVAC,
  plumbing, electrical, roofing?

AppFolio answers only the first question. QuickBooks goes partway
with Class Tracking and Location Tracking — but a single transaction
has exactly one class and one location, the dimensions are fixed at
two, and you can't define your own. The user ends up doing the
multi-dimensional analysis in Excel at year-end, which is precisely
what a good system should automate.

The pattern that fixes this is well-understood in data warehouses:
**fact + dimensions**. The fact is each posted `journal_line`. The
dimensions are queryable attributes that classify the fact from many
angles, simultaneously, without forcing a single rollup.

This isn't a vague nice-to-have — it's a genuine competitive
advantage. CPAs serving residential property managers are doing
bonus-depreciation and cost-segregation analysis manually because
existing platforms can't answer "show me every dollar that's a
bonus-depreciation candidate for fiscal 2026" in one query. Breeze
OS can.

## Data model

Two new tables, both pure many-to-many junction tables on top of the
existing schema.

### `gl_account_tags`

Account-level defaults. Every line posting against this account
inherits these tags as a starting point.

```
gl_account_tags
  gl_account_id  uuid       FK → gl_accounts.id, ON DELETE CASCADE
  namespace      text       'cost_class' | 'tax_treatment' | etc.
  value          text       'operating' | 'capitalized' | etc.
  notes          text       optional rationale
  created_at     timestamptz
  PRIMARY KEY (gl_account_id, namespace, value)

  INDEX gl_account_tags_ns_val ON (namespace, value)
```

Many-to-many in both directions:

- One account can have many tags (HVAC could be tagged
  `cost_class=operating` AND `functional=hvac` AND
  `tax_treatment=ordinary`).
- One (namespace, value) pair can apply to many accounts (every
  trade-repair account is tagged `functional=...`).

### `journal_line_tags`

Per-transaction overrides and additions. When a line posts, the
service layer materializes the effective tag set into this table:

1. Start with the account's tags (copied from `gl_account_tags`).
2. Apply any explicit per-line overrides supplied by the posting code
   or staff user.
3. Validate against the vocabulary rules (see below).
4. Insert one row per resulting (namespace, value) pair.

```
journal_line_tags
  journal_line_id  uuid     FK → journal_lines.id, ON DELETE CASCADE
  namespace        text
  value            text
  source           text     'account_default' | 'posting_explicit' |
                            'staff_override' | 'rule_engine'
  PRIMARY KEY (journal_line_id, namespace, value)

  INDEX journal_line_tags_ns_val_org
        ON (organization_id, namespace, value, journal_line_id)
```

Why materialize on the line instead of always joining back to the
account at query time:

1. **Reporting speed.** "All bonus-depreciation candidates in fiscal
   2026" is a single index scan on `journal_line_tags`, not a join
   through `gl_accounts` plus per-row override resolution.
2. **Immutability of posted entries.** Once a line is posted (per
   the Stage 1 triggers), its tags should be immutable too — they're
   part of the audit trail for what was claimed for tax. If the
   account's tags change later (e.g., a new tax law changes the
   default treatment), already-posted lines stay as recorded;
   future postings pick up the new defaults.
3. **`source` field for auditability.** Every tag has provenance —
   we can answer "did the staff member override this, or did it
   come from the account default?"

The `source` field is intentionally not an enum (yet) so we can grow
it without a migration: `'account_default'`, `'posting_explicit'`
(set by the service layer when the posting code passes tags),
`'staff_override'` (manually adjusted in the UI),
`'rule_engine'` (a future automatic-classifier rule fired).

## Controlled vocabularies

Namespaces and their valid values live in
`lib/accounting/tagVocabularies.js` — declared in code, not as DB
enums, so we can grow them without a migration and we can attach
validation rules (`implies`, `requires`, `forbids`) that read clearly
in code.

The file exports `TAG_VOCABULARIES` keyed by namespace. Each
namespace has:

- `description` — short human-readable purpose
- `values` — array of `{ value, label, description }` objects
- `implies` — optional array of rules: "if (this tag) then (other
  namespace must contain one of values X, Y, Z)"
- `forbids` — optional array of rules: "if (this tag) then (other
  namespace must NOT contain values X, Y, Z)"

### Initial vocabularies (residential PM)

**`cost_class`** — operating vs. one-time vs. capital classification.
The high-leverage report axis your operating partners care about.

| Value | Meaning |
|---|---|
| `operating` | Recurring operating expense; expensed in the period |
| `one_time` | Non-recurring expense but not capitalized |
| `capital_expense` | Should be capitalized to the balance sheet |
| `judgment_call` | Repair-vs-replacement edge case; flag for review |

**`tax_treatment`** — how this dollar should be treated for federal
income tax. Drives the year-end depreciation schedule.

| Value | Meaning |
|---|---|
| `ordinary` | Fully deductible in the current tax year |
| `section_179` | Qualifies for Section 179 expense election |
| `bonus_depreciation_candidate` | Qualifies for bonus depreciation under §168(k) |
| `capitalized_macrs` | Standard MACRS depreciation, no acceleration |
| `passive_loss_limited` | Subject to passive activity loss rules |
| `de_minimis_safe_harbor` | Under the de minimis threshold; expense in current year |

**`asset_category`** — depreciation class for capitalized items.

| Value | Recovery | Typical items |
|---|---|---|
| `building_residential` | 27.5 years | Residential rental structures |
| `building_commercial` | 39 years | Commercial / mixed-use structures |
| `land_improvement` | 15 years | Sidewalks, fences, landscaping, parking |
| `personal_property_5yr` | 5 years | Appliances, computers, autos |
| `personal_property_7yr` | 7 years | Furniture, office equipment |
| `intangible_section_197` | 15 years | Goodwill, customer lists, franchise rights |
| `non_capitalizable` | — | Sentinel for accounts that should never be capitalized |

**`business_context`** — *why* the spend happened.

| Value | Meaning |
|---|---|
| `routine` | Scheduled regular maintenance |
| `emergency` | Urgent, unscheduled |
| `turnover` | Between-tenants work |
| `make_ready` | Preparing for incoming tenant |
| `improvement` | Value-adding upgrade beyond restoration |
| `compliance` | Required by code, regulation, or inspector |
| `acquisition` | Related to property purchase |
| `disposition` | Related to property sale |

**`functional`** — finer-grain trade/category tag. Partially redundant
with `account_subtype` but useful for cross-account reporting (e.g.,
"all HVAC dollars regardless of which expense account they hit").
Could be dropped if `account_subtype` proves expressive enough.

| Value | |
|---|---|
| `hvac` | |
| `plumbing` | |
| `electrical` | |
| `roofing` | |
| `flooring` | |
| `paint` | |
| `appliance` | |
| `landscaping` | |
| `pest_control` | |
| `janitorial` | |
| `security` | |
| `pool` | |

### Validation rules

Encoded in `tagVocabularies.js` as JavaScript predicates so the
service layer can run them at post time and the UI can run them on
form change. Initial rules:

- `cost_class=capital_expense` **requires** a `tax_treatment` value
  in `{section_179, bonus_depreciation_candidate, capitalized_macrs}`.
- `cost_class=operating` **forbids** `tax_treatment` value
  `capitalized_macrs`.
- `tax_treatment=section_179` or `bonus_depreciation_candidate`
  **requires** an `asset_category` other than `non_capitalizable`.
- `tax_treatment=de_minimis_safe_harbor` **forbids**
  `cost_class=capital_expense`.

Violations don't necessarily reject the posting — for staff override,
they surface as warnings that require an explicit acknowledgment.
Auto-generated postings (recurring rent, AppFolio import) always
respect the rules.

## Default cascade

When a line posts:

1. The service layer looks up the gl_account's tags
   (`gl_account_tags`).
2. Any tags supplied with the post call (from the originating
   workflow — e.g., the maintenance ticket system tagging an HVAC
   line with `business_context=emergency`) are layered on top.
3. Conflicts within a namespace: posting-supplied wins over account-
   default. Multiple tags within the same namespace are allowed
   unless the vocabulary specifically forbids it.
4. The final set is validated against vocabulary rules.
5. The lines are inserted, and one `journal_line_tags` row is
   inserted per resulting (namespace, value), with the appropriate
   `source`.

The cascade happens at post time, not query time, so
posted lines never need to recurse back to the account to
reconstitute their effective tags.

## Reporting query patterns

The two index designs are tuned for these queries:

**"Show me all bonus-depreciation candidates for fiscal 2026."**

```sql
SELECT je.entry_date, je.memo, jl.gl_account_id,
       jl.debit_cents, jl.credit_cents, jl.property_id, jl.unit_id
  FROM journal_line_tags jlt
  JOIN journal_lines     jl ON jl.id = jlt.journal_line_id
  JOIN journal_entries   je ON je.id = jl.journal_entry_id
 WHERE jlt.organization_id = $orgId
   AND jlt.namespace = 'tax_treatment'
   AND jlt.value     = 'bonus_depreciation_candidate'
   AND je.entry_date BETWEEN '2026-01-01' AND '2026-12-31'
   AND je.status     = 'posted';
```

**"HVAC dollars by business context, last 12 months."**

```sql
SELECT bc.value     AS business_context,
       SUM(jl.debit_cents - jl.credit_cents) AS net_cents
  FROM journal_line_tags fn
  JOIN journal_lines     jl ON jl.id = fn.journal_line_id
  JOIN journal_line_tags bc ON bc.journal_line_id = jl.id
                             AND bc.namespace = 'business_context'
  JOIN journal_entries   je ON je.id = jl.journal_entry_id
 WHERE fn.organization_id = $orgId
   AND fn.namespace = 'functional'
   AND fn.value     = 'hvac'
   AND je.entry_date >= now() - interval '12 months'
   AND je.status     = 'posted'
 GROUP BY bc.value
 ORDER BY net_cents DESC;
```

**"Capitalized expenses by asset category, all-time."**

```sql
SELECT ac.value AS asset_category,
       SUM(jl.debit_cents) AS capitalized_cents
  FROM journal_line_tags cc
  JOIN journal_line_tags ac ON ac.journal_line_id = cc.journal_line_id
                             AND ac.namespace = 'asset_category'
  JOIN journal_lines     jl ON jl.id = cc.journal_line_id
  JOIN journal_entries   je ON je.id = jl.journal_entry_id
 WHERE cc.organization_id = $orgId
   AND cc.namespace = 'cost_class'
   AND cc.value     = 'capital_expense'
   AND je.status    = 'posted'
 GROUP BY ac.value
 ORDER BY capitalized_cents DESC;
```

All three are index scans on `journal_line_tags`, no recursive
hierarchy traversal, no per-row override resolution.

## What lands in Stage 2

When the AR schema migration runs, it'll co-migrate:

1. `gl_account_tags` + `journal_line_tags` tables (in a new
   `0008_multi_dimensional_tagging.sql` migration).
2. Drizzle schema additions in `lib/db/schema/accounting.js`
   (`glAccountTags`, `journalLineTags`).
3. A service-layer helper `applyDefaultTags(tx, journalLineId,
   glAccountId, overrides)` that the AR posting code calls.
4. Vocabulary validation hook in the same service module — reads
   `lib/accounting/tagVocabularies.js`.
5. Seed: as part of running the default-COA seeder or AppFolio
   importer, sensible default tags get assigned to known accounts
   (e.g., every 6xxx expense account picks up `cost_class=operating`
   and `tax_treatment=ordinary` by default; CapEx 7xxx accounts pick
   up `cost_class=capital_expense`).

## Open questions

- Should `functional` collapse into `account_subtype` (no parallel
  taxonomy)? Pro: less to maintain. Con: a single account can only
  have one subtype, while tagging is many-to-many.
- Do we want a `dimension_value_aliases` table so that, e.g.,
  `bonus_depreciation_candidate` can be referenced from external
  systems by short codes (`bonus_dep`) without rewriting the
  vocabulary? Probably yes, but not at first.
- For trust accounting v2: do beneficiary-level tags belong here?
  Beneficiary attribution is already on the journal_line itself
  (`beneficiary_type`, `beneficiary_id`); duplicating into tags
  would be redundant. Keep them separate.
- Performance: `journal_line_tags` will be the largest table in
  the system after `journal_lines` (typically ~3-5 tags per line).
  Composite index on `(organization_id, namespace, value)` is the
  main reporting hot path. Re-evaluate after we have real volume.

## Why this matters for the SaaS pitch

When Breeze OS is sold externally, the multi-dimensional tagging is
worth highlighting as a feature, not buried as schema. Concrete
demos:

- "Show me every bonus-depreciation candidate for last fiscal year"
  — one click in the UI, exports to PDF for the CPA.
- "How much did we spend on HVAC across emergency vs. routine
  this year?" — one chart, no Excel.
- "What capital expenses can we still front-load for tax planning
  before December 31?" — running ledger filtered by
  `cost_class=capital_expense, tax_treatment=bonus_depreciation_candidate`
  with the year-to-date view.

AppFolio competitors can't ship this without a schema migration.
That's a moat.
