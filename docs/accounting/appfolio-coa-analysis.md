# AppFolio Chart of Accounts — analysis + Breeze OS default template

Status: analysis output from the first live AppFolio introspection run
(Breeze Property Group, 2026-05-11). The full COA dump is **not**
committed to this repo — it contains operational details that aren't
needed in source control. The analysis below captures the structural
findings.

## Headline numbers

| Metric | Value |
|---|---|
| Total accounts | 254 |
| Active | 253 |
| Hidden | 1 (`2600 Mortgage Payable`) |
| Distinct account types | 8 |
| Funds | 1 (`Operating`) |
| Roots | 132 |
| With parent (2-level hierarchy) | 122 |

By `account_type`:

| Type | Count | What it actually contains |
|---|---|---|
| Expense | 104 | Operating + capital + some misclassified items |
| **Cash** | **45** | Bank accounts, credit cards, clearing buckets, junk |
| Income | 40 | Rent + fees + contra-income mixed together |
| Other Expense | 22 | Turnover, lender fees, depreciation, refi costs |
| Asset | 18 | Receivables, prepaid, fixed assets |
| Liability | 14 | AP, security deposits, mortgage, investor capital |
| Capital | 10 | Contributions, distributions, retained earnings |
| Other Income | 1 | Interest income |

## Key findings

### 1. 45 "Cash" accounts is the smoking gun for AppFolio's bank/GL conflation

The single largest issue in the chart. The Cash account_type is being
used as a catch-all for things that shouldn't be GL accounts at all in
a properly-modeled system. Breakdown of the 45:

- **Bank accounts (per-bank, per-LLC, per-entity)**: ~25 entries.
  Examples: `1149 Operating Cash (Breeze - PNC)`, `1151 Operating Cash
  (Breeze - Union Bank)`, `1212 Ottawa Park Toledo LLC (Union Bank)`,
  `1213 Uptown Arts Apartments LLC (Union Bank)`, `1218 501 E. Vine
  St. LLC`, `1221 Waterford - Money Market`, etc.
- **Credit cards masquerading as Cash**: 11 entries.
  `1191 Credit Card - Chase (Strehl)`, `1192 Credit Card - PNC`,
  `1193 Credit Card - Chase (Farmer)`, `1194 Credit Card - Chase
  (STauro)`, `1195 Credit Card - Chase (Rader)`, `1196 Credit Card -
  Chase (Dion)`, `1197 Credit Card - Chase (LTauro)`, `1198 Credit
  Card - Jones Chase Ink`, `1210 Credit Card - Chase Ink (Brown)`,
  `1211 Credit Card - Bill.com`. **Credit cards are liabilities, not
  cash** — putting them in Cash inverts the balance-sheet logic.
- **Clearing buckets**: `1142 Settlement Statement Clearing`, `1199
  Rent Credit Clearing`, `1200 Deposit Clearing`, `9991 Forced
  Reconciliation`. These are needed but should be Asset (Other
  Current) or even a dedicated "Clearing" subtype, not Cash.
- **Junk / dead accounts**: `1140 Junk 2 (Do Not Use)`, `1153
  Misplaced Funds 2`, `1190 Misplaced Funds`.

**Breeze OS implications.** This entire mess collapses into:

- **One** "Cash — Operating" GL account per `bank_account` row, 1:1
  via `bank_accounts.gl_account_id`.
- Credit cards become `bank_account` rows with `account_type='credit_card'`
  whose `gl_account_id` points at a **Liability** GL account
  (`2410 Credit Card - Operating` or similar), not a Cash one.
- Per-LLC bank accounts are still distinct `bank_account` rows but
  the OWNER attribution lives on `bank_account.owner_id` (and
  cascades to journal lines via the unit/property/owner attribution
  chain), not as separate GL accounts.

This is the single highest-leverage cleanup in cutover.

### 2. AppFolio doesn't have credit-card support — confirmed empirically

Breeze has eleven cards (Chase Strehl, PNC, Chase Farmer, Chase
STauro, Chase Rader, Chase Dion, Chase LTauro, Jones Chase Ink, Chase
Ink Brown, Bill.com, and one Amex via `1219 Breeze Property Group -
Strehl Amex`). Every single one is jammed into the "Cash" type
because AppFolio offers no proper credit-card primitive. This
validates Breeze's call-out from session start (*"AppFolio has no
credit card support"*) — there's no "Credit Card" account type in
AppFolio's schema. Breeze OS needs to ship native credit-card support
on day one.

### 3. Single fund, no trust segregation

Every account has `fund_account: "Operating"`. There's no Reserve
fund, no Trust fund, no escrow segregation in the GL. This is
consistent with Breeze being a landlord (managing own properties) and
not a fiduciary holding third-party owner funds in a regulated trust
account. Confirms the architecture-doc decision to defer trust
accounting to v2 but leave the structural seams (the `is_trust` flag,
beneficiary fields on journal lines) reserved.

### 4. AppFolio puts contra-income items in the Income type

Several "Income" accounts are actually GAAP-style **contra-income**
(reductions of gross potential rent):

- `4115 Gross Potential Rent`
- `4120 Loss/Gain to Market`
- `4210 Concessions` (+ child `4211 Section 8 Abatement Concessions`)
- `4220 Delinquency`
- `4230 Vacancy`

These should probably be a distinct "Contra-Income" classification or
at minimum a subtree under `4000 Rents`. Breeze OS's default template
will model them as proper contra-income with a debit normal balance
(or a separate sub-tree with a clear `Loss/Gain to Market`-style
naming convention).

### 5. Numbering and classification anomalies

| Account | Issue |
|---|---|
| `4100 Short Term Rent` AND `4150 Short Term Rent` | Two accounts, identical name — likely a duplicate from a merge or import |
| `4905 Mgmt Held Holding Deposits` | Liability type but numbered in the 4xxx (Income) range. Parent is `2100 SECURITY DEPOSITS` |
| `3397 Rent Conveyed after Closing` (Expense) and `3398 Rent Received after Closing` (Income) | Both in the 3xxx (Equity) range but classified as expense/income |
| `8003 Misplaced Charges` (Capital) | Numbered in 8xxx (Overhead) range, classified as Capital |
| `6600 Tenant Credit` (Expense) and `6610 One Time Tenant Credit` (Expense) | Tenant credits are obligations owed back to tenants — should be Liability, not Expense |
| `6125 LEGACY - Mortgage Principal and Interest...`, `9030 LEGACY - Mortgage P&I...`, `9090 LEGACY - Mortgage P&I + Escrow...` | Three "LEGACY" mortgage accounts kept around for historical entries — clutter |
| `9990 Portfolio Overhead - Deprecated`, `9991 Forced Reconciliation`, `7056 Short Term Rental Furnishings - Unnecessary` | Deprecation markers in the name itself |

These should be normalized at cutover. The Breeze OS schema's
`gl_account.code` is `text`, so we can keep the original AppFolio
codes during migration; but the *classifications* (account_type)
should be corrected.

### 6. AppFolio doesn't model Undeposited Funds explicitly

The data-model doc's `deposits` + `deposit_items` design (introducing
an Undeposited Funds intermediate GL) is **stronger** than AppFolio's
approach. AppFolio appears to work around the missing primitive
with `1200 Deposit Clearing`, `1199 Rent Credit Clearing`, and `1142
Settlement Statement Clearing` — three clearing accounts doing
overlapping jobs because none of them is *the* Undeposited Funds
account. Breeze OS's design fixes this with one canonical
`1110 Undeposited Funds` Asset account that every receipt posts into
before the deposit groups them and posts to Cash.

### 7. Named-individual sub-accounts mix entity ownership into the chart

Examples: `3131 Seller Financing Payments - Farmer`, `3132 Seller
Financing Payments - Ryan`. These should be **dimensions on journal
lines** (`owner_id`, `vendor_id`, `tenant_id`) rather than per-person
GL accounts. With 100+ owners over time, the chart of accounts would
explode if every owner gets their own sub-account.

### 8. Strong hierarchy where it exists

The Repairs (`6140`), Utilities (`6170`), Management Fees (`6110`),
Insurance (`6320`), Cleaning and Maintenance (`6070`), Auto and
Travel (`6060`), and Security Deposits (`2100`) sub-trees are
well-organized 2-level hierarchies. The Breeze OS default template
should preserve this structure — it's a reasonable industry pattern
and matches what AppFolio users (and probably future Breeze OS
customers coming from AppFolio) expect.

## Cutover-time cleanup candidates

These are accounts where the cutover importer should NOT carry the
AppFolio row straight across. Either remap or mark hidden+archived.

### Drop entirely (`is_active=false`, don't migrate)

- `1140 Junk 2 (Do Not Use)`
- `1141 Junk (Do Not Use)`
- `1153 Misplaced Funds 2`
- `1190 Misplaced Funds`
- `6125 LEGACY - Mortgage Principal and Interest due to depreciation`
- `9030 LEGACY - Mortgage P&I due to depreciation`
- `9090 LEGACY - Mortgage P&I + Escrow due to depreciation`
- `9990 Portfolio Overhead - Deprecated`
- `7056 Short Term Rental Furnishings - Unnecessary`

### Remap (rather than 1:1 migrate)

| AppFolio | Breeze OS target |
|---|---|
| 25 "Cash" bank accounts (1149, 1150, 1151, 1152, 1212-1221, etc.) | `bank_accounts` rows, each linked 1:1 to a single shared `1100 Cash - Operating` GL or to per-entity cash GLs if reporting demands it |
| 11 "Cash" credit cards (1191-1198, 1210, 1211, 1219) | `bank_accounts` rows with `account_type='credit_card'`, linked to Liability GL `2410 Credit Card - Operating` (or per-card liability sub-accounts) |
| `6600 Tenant Credit`, `6610 One Time Tenant Credit` | Liability `2200 Prepaid Rent / Tenant Credits` (re-classified) |
| `4905 Mgmt Held Holding Deposits` | Liability under `2100 Security Deposits Held` (number normalized) |
| `3131, 3132 Seller Financing Payments - <Name>` | Single `3130 Seller Financing Payments` GL; `<Name>` becomes `owner_id` dimension on journal lines |
| `4100` and `4150` (duplicate Short Term Rent) | Merge under one `4020 Rent - Short Term` |

### Number-only normalization

- `3397 Rent Conveyed after Closing` → 6xxx range (Expense)
- `3398 Rent Received after Closing` → 4xxx range (Income)
- `4905 Mgmt Held Holding Deposits` → 2xxx range (Liability)
- `8003 Misplaced Charges` → either 3xxx (Capital) or 1xxx Suspense

## Proposed Breeze OS default chart-of-accounts template

A clean residential-PM-friendly default that new Breeze OS orgs get
seeded with on creation. ~120 accounts (vs. Breeze's current 254
post-clutter). Aligned with the corrections above. Codes are 4-digit
text (per the schema), enabling future 5-digit growth without
migration.

### Assets (1000–1999)

```
1100  Cash - Operating                         [Cash]   ← 1:1 with primary bank_account
1110  Undeposited Funds                        [Cash]
1120  Settlement / Closing Clearing            [Cash]
1130  Suspense — Unreconciled                  [Cash]
1200  Accounts Receivable                      [Asset]  ← parent
  1210  AR — Rent
  1220  AR — Late Fees
  1230  AR — Utility Billbacks
  1240  AR — Other Charges
1300  Prepaid Expenses                         [Asset]
1310  Earnest Money Deposits Held              [Asset]
1400  Loans and Advances Due                   [Asset]
1500  Land                                     [Asset]
1600  Buildings                                [Asset]  ← parent
  1610  Buildings - Cost
  1620  Buildings - Accumulated Depreciation
1700  Other Property Assets                    [Asset]  ← parent
  1710  Improvements - Cost
  1720  Improvements - Accumulated Depreciation
  1730  Escrow Funds Held
  1740  Mortgage Escrow - Tax / Insurance
  1750  Intangible Assets
  1760  Intangible Assets - Accumulated Amortization
```

### Liabilities (2000–2999)

```
2000  Accounts Payable                         [Liability]  ← parent
  2010  AP — Trade Vendors
  2020  AP — Owner Distributions Pending
2100  Security Deposits Held                   [Liability]  ← parent (trust-aware in v2)
  2110  Tenant Security Deposits
  2120  Pet Deposits
  2130  Appliance Deposits
  2140  Holding Deposits
2200  Prepaid Rent / Tenant Credits            [Liability]  ← was "6600 Tenant Credit"
  2210  Prepaid Rent
  2220  Tenant Credit Balance
2300  Owner Funds Held                         [Liability]  ← parent (trust-aware in v2)
  2310  Owner Reserve Holdings
2400  Credit Cards Payable                     [Liability]  ← parent, 1:1 with bank_account credit_card rows
  2410  Credit Card - Operating
2500  Mortgages Payable                        [Liability]  ← parent
  2510  Mortgage Principal
  2520  Mortgage Interest Accrual
2600  Notes Payable / Seller Financing         [Liability]
2700  Investor Capital Payable                 [Liability]
2800  Other Liabilities                        [Liability]
```

### Equity / Capital (3000–3999)

```
3100  Owner Contributions                      [Equity]
3200  Owner Distributions                      [Equity]
3300  Retained Earnings - Current Year         [Equity]
3310  Retained Earnings - Prior Years          [Equity]
3400  Conveyances on Sale                      [Equity]
3900  Opening Balance Equity                   [Equity]   ← used at migration / org bootstrap
```

### Income (4000–4999)

```
4000  Rental Income                            [Income]  ← parent
  4010  Rent - Long Term
  4020  Rent - Short Term
  4030  Rent - Section 8
  4040  Rent - Pet
  4050  Rent - Appliance
  4060  Rent - Parking / Storage
4100  Contra-Income (rent adjustments)         [Income, debit normal]  ← parent
  4110  Concessions
  4111  Concessions - Section 8 Abatement
  4120  Loss to Market
  4130  Vacancy Loss
  4140  Delinquency
4200  Other Fee Income                         [Income]  ← parent
  4210  Late Fees
  4220  NSF Fees
  4230  Application Fees
  4240  Month-to-Month Fees
  4250  Pet Fees (Non-Refundable)
  4260  Move-Out Fees
  4270  Tax Passthrough
  4280  Insurance Services Fee
4300  Utility Reimbursements                   [Income]
4400  Management Fee Income                    [Income]
4500  Deposit Forfeit                          [Income]
4600  Laundry / Vending Income                 [Income]
4700  Insurance Proceeds                       [Income]
4800  Interest Income                          [Other Income]
4900  Misc Income                              [Income]
```

### Operating Expenses (6000–6999)

```
6010  Advertising                              [Expense]
6020  Auto and Travel                          [Expense]  ← parent
  6021  Mileage
  6022  Meals
  6023  Travel
6030  Cleaning and Maintenance                 [Expense]  ← parent
  6031  Carpet Cleaning
  6032  Janitorial
  6033  Pool Cleaning
  6034  Landscaping
  6035  HOA Dues
  6036  Pest Control
  6037  Snow Removal
  6038  General Maintenance Labor
  6039  Storage Space Rental
6040  Legal and Professional                   [Expense]  ← parent
  6041  Accounting
  6042  Legal
  6043  Professional Services - Other
6050  Management Fees                          [Expense]  ← parent
  6051  Property Management
  6052  Asset Management
  6053  Commissions / Placement Fees
  6054  Office Payroll
  6055  Payroll Taxes and Fees
  6056  AirBNB Host Service Fee
6070  Repairs                                  [Expense]  ← parent
  6071  Painting
  6072  Plumbing
  6073  Flooring
  6074  HVAC
  6075  Roofing
  6076  Electrical
  6077  Appliance Repairs
  6078  Key / Lock Replacement
  6079  General Repairs
  6080  Inspections
  6081  Supplies
6100  Property Taxes                           [Expense]  ← parent
  6110  Property Tax
  6120  Short-Term Occupancy Tax
  6130  Rental Tax Authority
6150  Utilities                                [Expense]  ← parent
  6151  Electricity
  6152  Gas
  6153  Water
  6154  Sewer
  6155  Garbage / Recycling
  6156  Internet
  6157  Telephone
  6158  Security Service Fees
  6159  Utilities - Aggregated (multi-utility allocations)
6200  Insurance                                [Expense]  ← parent
  6201  Property Insurance
  6202  Flood Insurance
  6203  Earthquake Insurance
  6204  Workers' Comp Insurance
  6205  Auto Insurance
  6206  GC Insurance
6300  Mortgage Interest (P&I expense portion)  [Expense]
6400  Bank Fees                                [Expense]
6500  Software / Tech                          [Expense]
6600  Tenant Screening                         [Expense]
6700  Misc Operating Expense                   [Expense]
```

### Capital Expenses (7000–7999)

```
7000  Capital Expenditures                     [Expense]  ← parent
  7010  Appliances
  7020  Equipment / Tools
  7030  Remodel
  7040  Roof Replacement
  7050  Furniture
  7060  Short-Term Rental Furnishings
7100  Turnover Expense                         [Expense]  ← parent
  7110  Turnover - General
  7120  Turnover - Repositioning
  7130  Turnover - New Units
  7140  Turnover - Insurance
```

### Overhead / Shared (8000–8999)

```
8000  Portfolio Overhead                       [Expense]  ← parent
  8010  Overhead - Payroll
  8020  Overhead - Software
  8030  Overhead - Processing Fees
8100  Acquisition Costs                        [Other Expense]  ← parent
  8110  Lender Fees
  8120  Title Fees
  8130  Broker Fees
  8140  Appraisal Fees
  8150  Acquisition Fees
8200  Refinancing Costs                        [Other Expense]
8300  Property Disposition Costs               [Other Expense]
```

### Other / Below-the-line (9000–9999)

```
9000  Depreciation Expense                     [Other Expense]
9010  Amortization Expense                     [Other Expense]
9100  Income Tax Expense                       [Other Expense]
9200  Mortgage Interest (below-the-line)       [Other Expense]
9300  Mortgage Servicing Fees                  [Other Expense]
9400  Title Insurance                          [Other Expense]
9500  Investor Distributions                   [Other Expense]
9600  Child Support / Garnishments             [Other Expense]
9900  Forced Reconciliation                    [Other Expense]   ← reserved for plug entries
```

## Template metadata

When this default template ships, every account gets:

- `is_active = true` (except a couple of system accounts that are
  always inactive until needed)
- `is_system = true` for the canonical Cash, AR, AP, Undeposited
  Funds, Suspense, Security Deposits Held, Tenant Credit, Owner
  Funds Held, Credit Cards Payable, Retained Earnings, and Opening
  Balance Equity rows — these can be renamed but not deleted
- `is_bank = false` initially; the trigger from Stage 3 will set it
  `true` when a `bank_account` links to the row
- `currency = 'USD'` per the v1 CHECK constraint
- `is_trust = false`, `trust_purpose = NULL` (trust accounting v2
  flips these on per-account when the platform onboards a trust)

## Stage 2 implications

Now that the COA shape is known, the next foreseeable schema work:

1. **Default-COA seeder** — a migration or service-layer function that
   creates the ~120 default accounts when a new `organizations` row
   is provisioned. Two flavors: `seedDefaultChartOfAccounts(orgId)`
   (idempotent) and `importAppFolioChart(orgId, accounts[])` for the
   migration path.
2. **Cutover importer (`api/admin/import-appfolio-coa.js`)** — pulls
   the live AppFolio chart, applies the remap rules above, writes
   `gl_accounts` rows, and emits an `audit_events` row per change.
   Outputs a "cleanup report" listing every account that was
   skipped, renamed, or remapped.
3. **AR module (Stage 2 proper)** — leases, tenants, scheduled
   charges, posted charges, receipts, deposits. The COA template
   above informs which GL accounts these will post against
   (`1110 Undeposited Funds`, `1210 AR — Rent`, `4010 Rent - Long
   Term`, `2210 Prepaid Rent`, etc.).

The cutover importer can wait until after AR is built — there's
nothing useful to do with the AppFolio data until we have the
receivables/deposits machinery to receive it.
