// Accounting — Stage 1 GL core + Stage 2 AR + multi-dimensional tags.
//
// Implements the load-bearing accounting tables from
// docs/accounting/data-model.md:
//
//   Stage 1 (GL core):
//     gl_accounts             chart of accounts
//     accounting_periods      open / closed reporting periods
//     journal_entries         header table for every money-moving event
//     journal_lines           the actual debits and credits
//     journal_entry_counters  per-org monotonic counter
//
//   Stage 2 (AR):
//     tenants                 lightweight contact records
//     leases                  unit-level lease records
//     lease_tenants           m2m: which tenants are on which lease
//     lease_rent_changes      audit log of rent_cents changes
//     scheduled_charges       forward-looking recurring charges
//     posted_charges          receivables on the books
//     receipts                "money in" records
//     receipt_allocations     how a receipt pays down posted_charges
//     deposits                groups of receipts hitting a bank account
//     deposit_items           m2m: which receipts belong to a deposit
//
//   Stage 2 (multi-dimensional tagging):
//     gl_account_tags         account-level default classifications
//     journal_line_tags       per-line materialised classification set
//
// Every monetary action in Breeze OS posts a journal entry — see the
// "Every money-moving event posts a journal entry" commitment in
// docs/accounting/architecture.md.
//
// Trust-accounting fields (is_trust, trust_purpose, beneficiary_*)
// are reserved as nullable so v2 is additive, not a rewrite.
//
// Posting integrity is enforced two ways:
//
//   1. Per-line constraints on debit_cents / credit_cents (declared
//      here in Drizzle's check()).
//   2. Per-entry balanced constraint (sum of debits = sum of credits)
//      enforced via a database trigger declared in the corresponding
//      SQL migration. Drizzle doesn't model triggers, so the schema
//      side documents the expectation and the migration owns the
//      implementation. Service-layer code must never bypass the
//      service that wraps INSERT INTO journal_lines.

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  bigint,
  integer,
  boolean,
  date,
  timestamp,
  real,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { organizations, users, entities } from './core.js';
import { owners, properties, units } from './directory.js';

// ── Enums ────────────────────────────────────────────────────────

// Five canonical types — the standard accounting set.
export const glAccountTypeEnum = pgEnum('gl_account_type', [
  'asset',
  'liability',
  'equity',
  'income',
  'expense',
]);

// Whether this account normally carries a debit or a credit balance.
// Derived from account_type but stored explicitly so posting code can
// look it up directly without re-deriving:
//   asset, expense    → debit
//   liability, equity, income → credit
export const glNormalBalanceEnum = pgEnum('gl_normal_balance', [
  'debit',
  'credit',
]);

// Period lifecycle.
//
//   open         — anyone with write access can post.
//   soft_closed  — books closed for normal posting; staff override
//                  allowed with an audit_events row recording who and
//                  why.
//   hard_closed  — locked permanently; no posting under any
//                  circumstance. Corrections go through a reversal +
//                  re-post against an open period.
export const accountingPeriodStatusEnum = pgEnum('accounting_period_status', [
  'open',
  'soft_closed',
  'hard_closed',
]);

// Classification of WHY this journal entry exists. The service layer
// branches on this when generating user-facing descriptions and when
// validating that the entry has the required source_table/source_id
// link back to its originating domain row.
export const journalEntryTypeEnum = pgEnum('journal_entry_type', [
  'receipt',
  'disbursement',
  'bill',
  'bill_payment',
  'recurring_charge_posting',
  'adjustment',
  'transfer',
  'opening_balance',
  'period_close',
]);

// Lifecycle of an entry.
//
//   draft     — editable; does not affect balances.
//   posted    — immutable; affects balances. Corrections via reversal.
//   reversed  — superseded by a reversing entry. Still queryable for
//               audit but does not contribute to current balances
//               (the reversing entry zeroes it out).
export const journalEntryStatusEnum = pgEnum('journal_entry_status', [
  'draft',
  'posted',
  'reversed',
]);

// ── gl_accounts ──────────────────────────────────────────────────

// Chart of accounts. Every journal line references one of these.
//
// code is text (not integer) so we support gapped numbering, alpha
// codes ("CASH-OP"), and longer numeric schemes (5- or 6-digit) without
// a schema migration when a customer outgrows the 4-digit default.
//
// parent_id is a self-FK for hierarchical accounts. Reporting rolls up
// the tree via recursive CTE.
//
// is_system marks accounts the platform requires (Cash, AR, AP,
// Undeposited Funds, Suspense, Rent Income, Security Deposits Held,
// etc.). is_system rows can be renamed but not deleted.
//
// is_bank is maintained automatically when bank_accounts.gl_account_id
// is set (via a trigger added in Stage 3). It exists here so reporting
// can filter cash accounts without joining bank_accounts.
export const glAccounts = pgTable(
  'gl_accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    accountType: glAccountTypeEnum('account_type').notNull(),
    // Free-form for v1 (cash, accounts_receivable, rent_income, etc.).
    // Promoted to an enum once the vocabulary settles.
    accountSubtype: text('account_subtype'),
    normalBalance: glNormalBalanceEnum('normal_balance').notNull(),
    parentId: uuid('parent_id').references(() => glAccounts.id, {
      onDelete: 'restrict',
    }),
    isActive: boolean('is_active').notNull().default(true),
    isSystem: boolean('is_system').notNull().default(false),
    isBank: boolean('is_bank').notNull().default(false),
    // Reserved for multi-currency v2. CHECK constraint in the migration
    // enforces 'USD' only in v1.
    currency: text('currency').notNull().default('USD'),
    // ── Trust accounting v2 reserved ──────────────────────────────
    isTrust: boolean('is_trust').notNull().default(false),
    // null | 'general_trust' | 'security_deposit_trust' | 'tax_escrow'
    trustPurpose: text('trust_purpose'),
    // Bill.com mapping (migration 0028). When this GL has a counterpart
    // in Bill.com's COA, write-back-on-confirm uses this id to tell
    // Bill.com what to code matched transactions as.
    billComChartOfAccountsId: text('bill_com_chart_of_accounts_id'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    codeUniq: uniqueIndex('gl_accounts_org_code_uniq').on(t.organizationId, t.code),
    orgTypeIdx: index('gl_accounts_org_type_idx').on(t.organizationId, t.accountType),
    parentIdx: index('gl_accounts_parent_idx').on(t.parentId),
    activeIdx: index('gl_accounts_active_idx').on(t.organizationId, t.isActive),
  }),
);

// ── accounting_periods ───────────────────────────────────────────

// One row per reporting period. Default cadence is monthly but the
// schema doesn't assume it — period_start / period_end can describe
// any range (daily, 3-day trailing, weekly, quarterly). The AI-driven
// near-real-time recon goal in architecture.md is what makes the
// flexible cadence valuable.
//
// status transitions:
//   open → soft_closed → hard_closed
// Backward transitions require an audit_events row and a service-layer
// override (no UI path).
export const accountingPeriods = pgTable(
  'accounting_periods',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    fiscalYear: integer('fiscal_year').notNull(),
    status: accountingPeriodStatusEnum('status').notNull().default('open'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedByUserId: uuid('closed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    periodUniq: uniqueIndex('accounting_periods_org_range_uniq').on(
      t.organizationId,
      t.periodStart,
      t.periodEnd,
    ),
    statusIdx: index('accounting_periods_org_status_idx').on(t.organizationId, t.status),
    fiscalIdx: index('accounting_periods_fiscal_idx').on(t.organizationId, t.fiscalYear),
  }),
);

// ── journal_entries ──────────────────────────────────────────────

// Header table for every business event that moves money or changes
// balances. The body lives in journal_lines.
//
// entry_number is a per-org monotonically increasing integer. The
// service layer generates it under a row lock on journal_entry_counters
// (defined in Stage 1's migration) so concurrent posts can't collide.
//
// entry_date is the ACCOUNTING date (the date used to determine which
// period the entry belongs to). Distinct from created_at — backdated
// entries set entry_date earlier than created_at.
//
// reversed_by_entry_id and reverses_entry_id implement entry reversal:
// the original entry stays as-is with reversed_by_entry_id pointing at
// the reversing entry; the reversing entry has reverses_entry_id
// pointing back. The pair is queryable from either side.
//
// source_table / source_id is a polymorphic reference back to whatever
// domain row generated this entry (receipts, posted_charges, bills,
// scheduled_charges, etc.). No DB-level FK because the target table
// varies. The service layer maintains the link.
export const journalEntries = pgTable(
  'journal_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    entryNumber: bigint('entry_number', { mode: 'number' }).notNull(),
    entryDate: date('entry_date').notNull(),
    periodId: uuid('period_id')
      .notNull()
      .references(() => accountingPeriods.id, { onDelete: 'restrict' }),
    entryType: journalEntryTypeEnum('entry_type').notNull(),
    sourceTable: text('source_table'),
    sourceId: uuid('source_id'),
    memo: text('memo'),
    status: journalEntryStatusEnum('status').notNull().default('draft'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedByUserId: uuid('posted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    reversedByEntryId: uuid('reversed_by_entry_id').references(
      () => journalEntries.id,
      { onDelete: 'set null' },
    ),
    reversesEntryId: uuid('reverses_entry_id').references(
      () => journalEntries.id,
      { onDelete: 'set null' },
    ),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    numberUniq: uniqueIndex('journal_entries_org_number_uniq').on(
      t.organizationId,
      t.entryNumber,
    ),
    dateIdx: index('journal_entries_org_date_idx').on(t.organizationId, t.entryDate),
    periodIdx: index('journal_entries_period_idx').on(t.periodId),
    sourceIdx: index('journal_entries_source_idx').on(t.sourceTable, t.sourceId),
    statusIdx: index('journal_entries_org_status_idx').on(t.organizationId, t.status),
    // status='posted' must have a posted_at timestamp.
    postedTimestamp: check(
      'journal_entries_posted_has_timestamp',
      sql`(${t.status} != 'posted') OR (${t.postedAt} IS NOT NULL)`,
    ),
  }),
);

// ── journal_lines ────────────────────────────────────────────────

// The actual debits and credits. Every line is exactly one of debit or
// credit (CHECK constraint). debit_cents and credit_cents are both
// non-negative bigint.
//
// Attribution chain — every line is attributed at the most specific
// level we know:
//
//   unit_id      → property_id → owner_id   (derived from the unit)
//
// The service layer denormalises property_id and owner_id when unit_id
// is set, so reporting can group by any level without recursive joins.
// Lines that don't attach to a specific unit (e.g. property-wide
// insurance, owner-level legal fees) populate property_id or owner_id
// directly.
//
// FK columns to leases/tenants/vendors are declared here as nullable
// uuid columns without FK constraints in this migration; the FK
// constraints will be ADDed in the Stage 2 (leases/tenants) and
// Stage 5 (vendors) migrations once those parent tables exist. This
// avoids re-migrating journal_lines later.
//
// Trust-accounting fields (beneficiary_type, beneficiary_id) are
// nullable in v1. The trust v2 migration will add a CHECK constraint
// requiring them to be populated whenever the line references an
// is_trust gl_account.
export const journalLines = pgTable(
  'journal_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    journalEntryId: uuid('journal_entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'restrict' }),
    glAccountId: uuid('gl_account_id')
      .notNull()
      .references(() => glAccounts.id, { onDelete: 'restrict' }),
    debitCents: bigint('debit_cents', { mode: 'number' }).notNull().default(0),
    creditCents: bigint('credit_cents', { mode: 'number' }).notNull().default(0),
    lineNumber: integer('line_number').notNull(),
    memo: text('memo'),
    // Attribution chain.
    unitId: uuid('unit_id').references(() => units.id, { onDelete: 'set null' }),
    propertyId: uuid('property_id').references(() => properties.id, {
      onDelete: 'set null',
    }),
    ownerId: uuid('owner_id').references(() => owners.id, {
      onDelete: 'set null',
    }),
    // Owning legal entity (LLC etc.). Drives per-entity P&L. Usually
    // resolved from propertyId → property.entity_id at posting time;
    // callers can override on lines that don't belong to a property
    // (corporate overhead, owner draws, intercompany).
    entityId: uuid('entity_id').references(() => entities.id, {
      onDelete: 'set null',
    }),
    // Intercompany counterparty. Populated only on lines that hit
    // 1450 Intercompany Receivable or 2050 Intercompany Payable; the
    // lender's IC AR line carries the borrower as counterparty, and
    // vice versa. Consolidation elimination joins on
    // (a.entity_id, a.counterparty_entity_id) = (b.counterparty_entity_id,
    //  b.entity_id) across the IC AR/AP pair.
    counterpartyEntityId: uuid('counterparty_entity_id').references(
      () => entities.id,
      { onDelete: 'set null' },
    ),
    // Domain attribution — uuid columns now, FK constraints added in
    // later-stage migrations when the target tables exist.
    leaseId: uuid('lease_id'),
    tenantId: uuid('tenant_id'),
    vendorId: uuid('vendor_id'),
    // ── Trust accounting v2 reserved ──────────────────────────────
    // 'owner' | 'tenant' | 'vendor' | etc.
    beneficiaryType: text('beneficiary_type'),
    beneficiaryId: uuid('beneficiary_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // The index that drives every balance-as-of-date query.
    accountEntryIdx: index('journal_lines_org_account_entry_idx').on(
      t.organizationId,
      t.glAccountId,
      t.journalEntryId,
    ),
    entryIdx: index('journal_lines_entry_idx').on(t.journalEntryId),
    unitIdx: index('journal_lines_org_unit_idx').on(t.organizationId, t.unitId),
    propertyIdx: index('journal_lines_org_property_idx').on(t.organizationId, t.propertyId),
    ownerIdx: index('journal_lines_org_owner_idx').on(t.organizationId, t.ownerId),
    entityIdx: index('journal_lines_org_entity_idx').on(t.organizationId, t.entityId),
    counterpartyEntityIdx: index('journal_lines_counterparty_entity_idx').on(
      t.counterpartyEntityId,
    ),
    leaseIdx: index('journal_lines_lease_idx').on(t.leaseId),
    tenantIdx: index('journal_lines_tenant_idx').on(t.tenantId),
    vendorIdx: index('journal_lines_vendor_idx').on(t.vendorId),
    // Exactly one side of the entry is non-zero.
    oneSideNonZero: check(
      'journal_lines_one_side_non_zero',
      sql`(${t.debitCents} = 0) <> (${t.creditCents} = 0)`,
    ),
    nonNegative: check(
      'journal_lines_non_negative',
      sql`${t.debitCents} >= 0 AND ${t.creditCents} >= 0`,
    ),
  }),
);

// ── journal_entry_counters ───────────────────────────────────────

// Per-organization monotonic counter for journal_entries.entry_number.
// One row per organization; the service layer takes a FOR UPDATE lock
// on this row inside the same transaction that inserts the JE, so
// concurrent posts serialize cleanly.
//
// Drizzle-defined here so the table is visible in queries; populated by
// the migration's INSERT-on-first-org trigger pattern.
export const journalEntryCounters = pgTable('journal_entry_counters', {
  organizationId: uuid('organization_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  nextValue: bigint('next_value', { mode: 'number' }).notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ═════════════════════════════════════════════════════════════════
//                         STAGE 2 — AR
// ═════════════════════════════════════════════════════════════════

// ── AR enums ─────────────────────────────────────────────────────

export const leaseStatusEnum = pgEnum('lease_status', [
  'draft',
  'active',
  'notice_given',
  'ended',
  'evicted',
]);

export const leaseTenantRoleEnum = pgEnum('lease_tenant_role', [
  'primary',
  'co_signer',
  'occupant',
  'guarantor',
]);

export const chargeFrequencyEnum = pgEnum('charge_frequency', [
  'monthly',
  'quarterly',
  'annual',
  'one_time',
]);

export const scheduledChargeStatusEnum = pgEnum('scheduled_charge_status', [
  'active',
  'paused',
  'ended',
]);

export const postedChargeStatusEnum = pgEnum('posted_charge_status', [
  'open',
  'partially_paid',
  'paid',
  'voided',
]);

export const paymentMethodEnum = pgEnum('payment_method', [
  'ach',
  'check',
  'credit_card',
  'cash',
  'money_order',
  'paynearme',
  'section_8',
  'other',
]);

export const receiptStatusEnum = pgEnum('receipt_status', [
  'pending',
  'cleared',
  'nsf_returned',
  'voided',
]);

export const depositTypeEnum = pgEnum('deposit_type', [
  'check_batch',
  'ach_batch',
  'cash',
  'wire',
  'section_8_omnibus',
  'other',
]);

export const depositStatusEnum = pgEnum('deposit_status', [
  'pending',
  'cleared',
  'nsf_returned',
  'voided',
]);

export const tagSourceEnum = pgEnum('tag_source', [
  'account_default',
  'posting_explicit',
  'staff_override',
  'rule_engine',
]);

// ── tenants ──────────────────────────────────────────────────────

// Lightweight contact record. Most detail (occupants, contacts on
// file with employers / emergency contacts) lives in a future
// `contacts` or `parties` table; this is the minimum to attach a
// tenant to a lease and a receipt.
export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    firstName: text('first_name'),
    lastName: text('last_name'),
    // Cached "First Last" for queries and search. Service layer
    // maintains this on writes.
    displayName: text('display_name').notNull(),
    email: text('email'),
    phone: text('phone'),
    mobilePhone: text('mobile_phone'),
    // External source breadcrumb (AppFolio tenant id during migration).
    sourceTenantId: text('source_tenant_id'),
    sourcePms: text('source_pms').notNull().default('appfolio'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgIdx: index('tenants_org_idx').on(t.organizationId),
    sourceIdx: index('tenants_source_idx').on(t.sourceTenantId),
    emailIdx: index('tenants_email_idx').on(t.email),
    displayNameIdx: index('tenants_display_name_idx').on(t.displayName),
  }),
);

// ── leases ───────────────────────────────────────────────────────

// Unit-level lease record. lease_number is the human-readable
// identifier; one lease may have many tenants (jointly and severally
// liable) via lease_tenants.
//
// rent_cents is the CURRENT monthly rent. Historical changes are
// captured in lease_rent_changes so we can answer "what was the rent
// on 2025-08-15?" without losing the audit trail.
export const leases = pgTable(
  'leases',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => units.id, { onDelete: 'restrict' }),
    leaseNumber: text('lease_number').notNull(),
    status: leaseStatusEnum('status').notNull().default('draft'),
    startDate: date('start_date').notNull(),
    // Null for month-to-month.
    endDate: date('end_date'),
    rentCents: bigint('rent_cents', { mode: 'number' }).notNull(),
    rentDueDay: integer('rent_due_day').notNull().default(1),
    // Optional overrides; fall back to property/org defaults when null.
    lateFeeCents: bigint('late_fee_cents', { mode: 'number' }),
    lateFeeGraceDays: integer('late_fee_grace_days'),
    securityDepositCents: bigint('security_deposit_cents', { mode: 'number' })
      .notNull()
      .default(0),
    sourceLeaseId: text('source_lease_id'),
    sourcePms: text('source_pms').notNull().default('appfolio'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    leaseNumberUniq: uniqueIndex('leases_org_lease_number_uniq').on(
      t.organizationId,
      t.leaseNumber,
    ),
    orgStatusIdx: index('leases_org_status_idx').on(t.organizationId, t.status),
    unitIdx: index('leases_unit_idx').on(t.unitId),
    sourceIdx: index('leases_source_idx').on(t.sourceLeaseId),
  }),
);

// ── lease_tenants ────────────────────────────────────────────────

// Many-to-many between leases and tenants. role distinguishes the
// primary leaseholder (usually one) from co-signers, occupants
// (children, roommates not on the lease), and guarantors.
export const leaseTenants = pgTable(
  'lease_tenants',
  {
    leaseId: uuid('lease_id')
      .notNull()
      .references(() => leases.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    role: leaseTenantRoleEnum('role').notNull().default('primary'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.leaseId, t.tenantId] }),
    tenantIdx: index('lease_tenants_tenant_idx').on(t.tenantId),
    roleIdx: index('lease_tenants_role_idx').on(t.role),
  }),
);

// ── lease_rent_changes ───────────────────────────────────────────

// Append-only audit of rent_cents changes on a lease. The current
// rent lives on leases.rent_cents; this table answers "what was the
// rent at any historical point in time" for reporting and disputes.
export const leaseRentChanges = pgTable(
  'lease_rent_changes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    leaseId: uuid('lease_id')
      .notNull()
      .references(() => leases.id, { onDelete: 'cascade' }),
    effectiveDate: date('effective_date').notNull(),
    oldRentCents: bigint('old_rent_cents', { mode: 'number' }).notNull(),
    newRentCents: bigint('new_rent_cents', { mode: 'number' }).notNull(),
    changedByUserId: uuid('changed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    leaseDateIdx: index('lease_rent_changes_lease_date_idx').on(
      t.leaseId,
      t.effectiveDate,
    ),
    orgIdx: index('lease_rent_changes_org_idx').on(t.organizationId),
  }),
);

// ── scheduled_charges ────────────────────────────────────────────

// Forward-looking recurring obligation. A cron fires when
// next_due_date <= today AND status='active', creating a
// posted_charges row and the corresponding JE.
//
// lease_id is the most common attachment (recurring rent), but
// non-lease scheduled charges are allowed for property-wide
// recurring items (insurance allocations, HOA dues).
export const scheduledCharges = pgTable(
  'scheduled_charges',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    leaseId: uuid('lease_id').references(() => leases.id, {
      onDelete: 'cascade',
    }),
    unitId: uuid('unit_id').references(() => units.id, {
      onDelete: 'set null',
    }),
    propertyId: uuid('property_id').references(() => properties.id, {
      onDelete: 'set null',
    }),
    chargeType: text('charge_type').notNull(),
    description: text('description').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    glAccountId: uuid('gl_account_id')
      .notNull()
      .references(() => glAccounts.id, { onDelete: 'restrict' }),
    frequency: chargeFrequencyEnum('frequency').notNull(),
    nextDueDate: date('next_due_date').notNull(),
    endDate: date('end_date'),
    status: scheduledChargeStatusEnum('status').notNull().default('active'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    dueIdx: index('scheduled_charges_due_idx').on(
      t.organizationId,
      t.nextDueDate,
      t.status,
    ),
    leaseIdx: index('scheduled_charges_lease_idx').on(t.leaseId),
    unitIdx: index('scheduled_charges_unit_idx').on(t.unitId),
    propertyIdx: index('scheduled_charges_property_idx').on(t.propertyId),
  }),
);

// ── posted_charges ───────────────────────────────────────────────

// Receivable on the books. Created when a scheduled_charge fires or
// when staff posts an ad-hoc charge. Backed by a journal_entry that
// debits AR and credits the appropriate income GL.
//
// balance_cents starts equal to amount_cents and decreases as
// receipt_allocations apply against it. When balance hits zero,
// status transitions to 'paid'.
export const postedCharges = pgTable(
  'posted_charges',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    scheduledChargeId: uuid('scheduled_charge_id').references(
      () => scheduledCharges.id,
      { onDelete: 'set null' },
    ),
    leaseId: uuid('lease_id').references(() => leases.id, {
      onDelete: 'set null',
    }),
    unitId: uuid('unit_id').references(() => units.id, {
      onDelete: 'set null',
    }),
    propertyId: uuid('property_id').references(() => properties.id, {
      onDelete: 'set null',
    }),
    tenantId: uuid('tenant_id').references(() => tenants.id, {
      onDelete: 'set null',
    }),
    chargeType: text('charge_type').notNull(),
    description: text('description').notNull(),
    chargeDate: date('charge_date').notNull(),
    dueDate: date('due_date').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    balanceCents: bigint('balance_cents', { mode: 'number' }).notNull(),
    glAccountId: uuid('gl_account_id')
      .notNull()
      .references(() => glAccounts.id, { onDelete: 'restrict' }),
    journalEntryId: uuid('journal_entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'restrict' }),
    status: postedChargeStatusEnum('status').notNull().default('open'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    statusDueIdx: index('posted_charges_status_due_idx').on(
      t.organizationId,
      t.status,
      t.dueDate,
    ),
    leaseIdx: index('posted_charges_lease_idx').on(t.leaseId),
    tenantIdx: index('posted_charges_tenant_idx').on(t.tenantId),
    unitIdx: index('posted_charges_unit_idx').on(t.unitId),
    scheduledIdx: index('posted_charges_scheduled_idx').on(t.scheduledChargeId),
    jeIdx: index('posted_charges_je_idx').on(t.journalEntryId),
  }),
);

// ── deposits ─────────────────────────────────────────────────────

// A bundle of receipts that physically (check-scanner batch) or
// logically (ACH settlement, Section 8 omnibus) lands in a bank
// account together. Defined BEFORE receipts because receipts FK
// back to deposit_id.
//
// bank_account_id is uuid (no FK constraint) for now — the
// bank_accounts table lands in Stage 3, at which point a
// follow-up migration adds the FK constraint.
export const deposits = pgTable(
  'deposits',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    bankAccountId: uuid('bank_account_id'),
    depositDate: date('deposit_date').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    depositType: depositTypeEnum('deposit_type').notNull(),
    externalReference: text('external_reference'),
    journalEntryId: uuid('journal_entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'restrict' }),
    status: depositStatusEnum('status').notNull().default('pending'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgDateIdx: index('deposits_org_date_idx').on(
      t.organizationId,
      t.depositDate,
    ),
    bankAccountStatusIdx: index('deposits_bank_status_idx').on(
      t.bankAccountId,
      t.status,
    ),
    refIdx: index('deposits_external_reference_idx').on(t.externalReference),
  }),
);

// ── receipts ─────────────────────────────────────────────────────

// "Money in" record. Does NOT directly hit a bank account — it
// posts to Undeposited Funds (1110) until grouped into a deposit
// (which then posts to Cash). deposit_id is null while the receipt
// is in undeposited funds.
//
// One JE per receipt; allocations against posted_charges are
// modeled in receipt_allocations.
export const receipts = pgTable(
  'receipts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id').references(() => tenants.id, {
      onDelete: 'set null',
    }),
    leaseId: uuid('lease_id').references(() => leases.id, {
      onDelete: 'set null',
    }),
    receivedDate: date('received_date').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    paymentMethod: paymentMethodEnum('payment_method').notNull(),
    externalReference: text('external_reference'),
    depositId: uuid('deposit_id').references(() => deposits.id, {
      onDelete: 'set null',
    }),
    journalEntryId: uuid('journal_entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'restrict' }),
    status: receiptStatusEnum('status').notNull().default('pending'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgDateIdx: index('receipts_org_date_idx').on(
      t.organizationId,
      t.receivedDate,
    ),
    tenantIdx: index('receipts_tenant_idx').on(t.tenantId),
    leaseIdx: index('receipts_lease_idx').on(t.leaseId),
    depositIdx: index('receipts_deposit_idx').on(t.depositId),
    refIdx: index('receipts_external_reference_idx').on(t.externalReference),
    jeIdx: index('receipts_je_idx').on(t.journalEntryId),
  }),
);

// ── receipt_allocations ──────────────────────────────────────────

// Many-to-many between receipts and posted_charges. A $2150 receipt
// paying $2100 rent + $50 late fee = one receipt, two allocations.
//
// Trigger enforces: SUM(receipt_allocations.amount_cents) per receipt
// ≤ receipts.amount_cents. Any unallocated remainder sits in
// 2210 Prepaid Rent (a tenant credit liability) until allocated.
export const receiptAllocations = pgTable(
  'receipt_allocations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => receipts.id, { onDelete: 'cascade' }),
    postedChargeId: uuid('posted_charge_id')
      .notNull()
      .references(() => postedCharges.id, { onDelete: 'restrict' }),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    receiptIdx: index('receipt_allocations_receipt_idx').on(t.receiptId),
    chargeIdx: index('receipt_allocations_charge_idx').on(t.postedChargeId),
  }),
);

// ── deposit_items ────────────────────────────────────────────────

// Many-to-many between deposits and receipts. A receipt belongs to
// at most one deposit (enforced by UNIQUE on receipt_id). Stored
// separately from receipts.deposit_id so the deposit-side amount
// can diverge from the receipt amount in rare edge cases
// (oversize check split across two deposits) without rewriting
// the receipt.
export const depositItems = pgTable(
  'deposit_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    depositId: uuid('deposit_id')
      .notNull()
      .references(() => deposits.id, { onDelete: 'cascade' }),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => receipts.id, { onDelete: 'restrict' }),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    receiptUniq: uniqueIndex('deposit_items_receipt_uniq').on(t.receiptId),
    depositIdx: index('deposit_items_deposit_idx').on(t.depositId),
  }),
);

// ═════════════════════════════════════════════════════════════════
//             STAGE 2 — Multi-dimensional tagging
// ═════════════════════════════════════════════════════════════════
//
// See docs/accounting/multi-dimensional-tagging.md for the design.
// Vocabularies live in lib/accounting/tagVocabularies.js (not in
// the DB) so they can evolve without migrations.

// ── gl_account_tags ──────────────────────────────────────────────

// Account-level default tags. Every line posting against this
// account inherits these as a starting point.
export const glAccountTags = pgTable(
  'gl_account_tags',
  {
    glAccountId: uuid('gl_account_id')
      .notNull()
      .references(() => glAccounts.id, { onDelete: 'cascade' }),
    namespace: text('namespace').notNull(),
    value: text('value').notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.glAccountId, t.namespace, t.value] }),
    nsValueIdx: index('gl_account_tags_ns_value_idx').on(t.namespace, t.value),
  }),
);

// ── journal_line_tags ────────────────────────────────────────────

// Per-line materialised tag set. The service layer copies account
// defaults onto the line at post time, then applies any explicit
// overrides supplied by the posting code or staff.
//
// organization_id is denormalised here (not just on journal_lines)
// so reporting queries can scan
//   (organization_id, namespace, value)
// directly without joining back to journal_lines first.
export const journalLineTags = pgTable(
  'journal_line_tags',
  {
    journalLineId: uuid('journal_line_id')
      .notNull()
      .references(() => journalLines.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    namespace: text('namespace').notNull(),
    value: text('value').notNull(),
    source: tagSourceEnum('source').notNull().default('account_default'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.journalLineId, t.namespace, t.value] }),
    reportingIdx: index('journal_line_tags_reporting_idx').on(
      t.organizationId,
      t.namespace,
      t.value,
    ),
    lineIdx: index('journal_line_tags_line_idx').on(t.journalLineId),
  }),
);

// ═════════════════════════════════════════════════════════════════
//                       STAGE 3 — Banking
// ═════════════════════════════════════════════════════════════════

// ── Banking enums ────────────────────────────────────────────────

export const bankAccountTypeEnum = pgEnum('bank_account_type', [
  'checking',
  'savings',
  'money_market',
  'credit_card',
  'investment',
]);

export const plaidLinkStatusEnum = pgEnum('plaid_link_status', [
  'unlinked',
  'linked',
  're_auth_required',
  'disconnected',
]);

export const matchCandidateStatusEnum = pgEnum('match_candidate_status', [
  'auto_matched',
  'pending_review',
  'confirmed',
  'rejected',
]);

// ── bank_accounts ────────────────────────────────────────────────

// Real-world banking object. Linked 1:1 to a gl_account via the
// UNIQUE constraint on gl_account_id — exactly one bank_account per
// cash/credit GL account. Sweeps, transfers between accounts, etc.
// are modeled as two GL accounts plus a transfer journal entry,
// never as one GL fanning out.
//
// Routing and account numbers are encrypted via pgcrypto, same
// pattern as owners.ein_encrypted. account_last4 is unencrypted for
// display.
export const bankAccounts = pgTable(
  'bank_accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    // UNIQUE — enforces the 1:1 invariant. Two bank_accounts cannot
    // share the same GL account.
    glAccountId: uuid('gl_account_id')
      .notNull()
      .references(() => glAccounts.id, { onDelete: 'restrict' }),
    displayName: text('display_name').notNull(),
    institutionName: text('institution_name'),
    accountType: bankAccountTypeEnum('account_type').notNull(),
    routingNumberEncrypted: text('routing_number_encrypted'),
    accountNumberEncrypted: text('account_number_encrypted'),
    accountLast4: text('account_last4'),
    // Latest known balance per Plaid sync or manual entry. NOT
    // the GL balance — those should agree after three-way recon.
    currentBalanceCents: bigint('current_balance_cents', { mode: 'number' }),
    balanceAsOf: timestamp('balance_as_of', { withTimezone: true }),
    // ── Plaid integration ─────────────────────────────────────────
    plaidItemId: text('plaid_item_id'),
    plaidAccountId: text('plaid_account_id'),
    plaidCursor: text('plaid_cursor'),
    plaidStatus: plaidLinkStatusEnum('plaid_status').notNull().default('unlinked'),
    // Encrypted via lib/encryption.js (AES-256-GCM, BREEZE_ENCRYPTION_KEY).
    // Format: "iv:tag:ciphertext" hex strings.
    plaidAccessTokenEncrypted: text('plaid_access_token_encrypted'),
    // ── Trust accounting v2 reserved ─────────────────────────────
    isTrust: boolean('is_trust').notNull().default(false),
    trustPurpose: text('trust_purpose'),
    // Bill.com mapping (migration 0026). Set per-bank-account after
    // the funding source is verified in Bill.com.
    billComBankAccountId: text('bill_com_bank_account_id'),
    // Bill.com charge-card account mapping (migration 0028). Set
    // when the bank_account row represents a Bill.com Spend card.
    billComCardAccountId: text('bill_com_card_account_id'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    glAccountUniq: uniqueIndex('bank_accounts_gl_account_uniq').on(t.glAccountId),
    orgIdx: index('bank_accounts_org_idx').on(t.organizationId),
    plaidItemIdx: index('bank_accounts_plaid_item_idx').on(t.plaidItemId),
    plaidAccountIdx: index('bank_accounts_plaid_account_idx').on(t.plaidAccountId),
  }),
);

// ── bank_transactions ────────────────────────────────────────────

// Immutable raw feed of what the bank shows. Once ingested, a row
// here never changes; corrections happen via inverse entries on
// the ledger side, not by editing bank_transactions.
//
// amount_cents follows Plaid's sign convention: positive = money
// out of the account, negative = money in. The service layer
// documents and respects this when generating match candidates.
export const bankTransactions = pgTable(
  'bank_transactions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id, { onDelete: 'cascade' }),
    // Plaid transaction id, or `manual:<uuid>` for hand-entered.
    externalId: text('external_id').notNull(),
    postedDate: date('posted_date').notNull(),
    // Plaid sign convention: positive = debit (money out), negative
    // = credit (money in). See service-layer comments before
    // matching this to journal_lines.
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    description: text('description'),
    merchantName: text('merchant_name'),
    pending: boolean('pending').notNull().default(false),
    // Full Plaid payload (or manual blob) for forensics. We never
    // edit this — corrections happen as new ledger entries.
    rawPayload: jsonb('raw_payload'),
    // Bill.com mapping (migration 0028). The swipe transaction id
    // on Bill.com's side, populated when this row originated from a
    // Bill.com card transaction sync.
    billComTransactionId: text('bill_com_transaction_id'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    externalIdUniq: uniqueIndex('bank_transactions_external_uniq').on(
      t.bankAccountId,
      t.externalId,
    ),
    postedDateIdx: index('bank_transactions_org_posted_idx').on(
      t.organizationId,
      t.postedDate,
    ),
    pendingIdx: index('bank_transactions_pending_idx').on(
      t.bankAccountId,
      t.pending,
    ),
  }),
);

// ── match_candidates ─────────────────────────────────────────────

// Fuzzy-reconciliation queue between bank_transactions and
// journal_entries.
//
// Many candidates per bank_transaction is legal — the UI shows them
// ranked by confidence_score. A partial unique index (created in
// the migration) ensures only one candidate per bank_transaction
// can be `confirmed`.
//
// match_reason_codes is a text[] of human-readable rule tags like
// 'exact_amount', 'date_within_3d', 'tenant_name_match',
// 'learned_rule_id:<uuid>'. The service layer composes them.
export const matchCandidates = pgTable(
  'match_candidates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    bankTransactionId: uuid('bank_transaction_id')
      .notNull()
      .references(() => bankTransactions.id, { onDelete: 'cascade' }),
    journalEntryId: uuid('journal_entry_id').references(
      () => journalEntries.id,
      { onDelete: 'set null' },
    ),
    // 0.000 — 1.000. Stored as real (float4) for speed; precision is
    // plenty for ranking.
    confidenceScore: real('confidence_score'),
    matchReasonCodes: text('match_reason_codes').array(),
    status: matchCandidateStatusEnum('status').notNull().default('pending_review'),
    confirmedByUserId: uuid('confirmed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgStatusIdx: index('match_candidates_org_status_idx').on(
      t.organizationId,
      t.status,
    ),
    bankTxnIdx: index('match_candidates_bank_txn_idx').on(t.bankTransactionId),
    jeIdx: index('match_candidates_je_idx').on(t.journalEntryId),
  }),
);

// ── match_rules ──────────────────────────────────────────────────

// Pattern-matching rules that improve recon over time. v1 is staff-
// entered; v2 learns from confirmed/rejected matches.
//
// pattern_type taxonomy (v1): description_regex, amount_exact,
// amount_range, merchant_name, composite. pattern_payload carries
// the per-type config; target carries where matches should route
// ({ tenant_id, gl_account_id, posted_charge_id? } etc.).
export const matchRules = pgTable(
  'match_rules',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    patternType: text('pattern_type').notNull(),
    patternPayload: jsonb('pattern_payload').notNull(),
    target: jsonb('target').notNull(),
    confidenceScore: real('confidence_score').notNull(),
    timesUsed: integer('times_used').notNull().default(0),
    timesRejected: integer('times_rejected').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    // The user's original one-liner (natural language) that
    // produced this rule via the LLM rule generator. Surfaced in
    // the rules-management UI so staff can read what each rule
    // does without parsing pattern_payload jsonb.
    naturalLanguageDescription: text('natural_language_description'),
    // When the auto-match worker most recently produced a candidate
    // from this rule. Updated by the matchEngine on every match.
    lastMatchedAt: timestamp('last_matched_at', { withTimezone: true }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgActiveIdx: index('match_rules_org_active_idx').on(
      t.organizationId,
      t.isActive,
    ),
  }),
);
