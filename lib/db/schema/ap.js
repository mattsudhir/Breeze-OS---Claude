// Accounts payable — Stage 5.
//
// Vendors are anyone we pay (plumbers, utilities, taxing authorities,
// insurance carriers, etc.). Bills + bill_payments arrive in later
// migrations (0024, 0025); this module starts with vendors.

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  date,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './core.js';
import { glAccounts, journalEntries, bankAccounts } from './accounting.js';
import { entities } from './core.js';
import { properties, units } from './directory.js';

export const vendorTypeEnum = pgEnum('vendor_type', [
  'individual',
  'business',
  'government',
  'utility',
  'insurance',
  'other',
]);

export const vendors = pgTable(
  'vendors',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    legalName: text('legal_name'),
    vendorType: vendorTypeEnum('vendor_type').notNull().default('business'),
    contactEmail: text('contact_email'),
    contactPhone: text('contact_phone'),
    remitAddressLine1: text('remit_address_line1'),
    remitAddressLine2: text('remit_address_line2'),
    remitCity: text('remit_city'),
    remitState: text('remit_state'),
    remitZip: text('remit_zip'),
    taxIdEncrypted: text('tax_id_encrypted'),
    taxIdLast4: text('tax_id_last4'),
    is1099Eligible: boolean('is_1099_eligible').notNull().default(false),
    paymentTermsDays: integer('payment_terms_days').notNull().default(30),
    defaultGlAccountId: uuid('default_gl_account_id').references(
      () => glAccounts.id,
      { onDelete: 'set null' },
    ),
    sourceVendorId: text('source_vendor_id'),
    sourcePms: text('source_pms').notNull().default('appfolio'),
    isActive: boolean('is_active').notNull().default(true),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgIdx: index('vendors_org_idx').on(t.organizationId),
    orgActiveIdx: index('vendors_org_active_idx').on(t.organizationId, t.isActive),
    sourceIdx: index('vendors_source_idx').on(t.sourceVendorId),
    displayNameIdx: index('vendors_display_name_idx').on(t.displayName),
    orgNameUniq: uniqueIndex('vendors_org_name_uniq')
      .on(t.organizationId, sql`lower(${t.displayName})`)
      .where(sql`${t.isActive} = true`),
  }),
);

// ── Bills ───────────────────────────────────────────────────────

export const billStatusEnum = pgEnum('bill_status', ['draft', 'posted', 'voided']);
export const billPaymentStatusEnum = pgEnum('bill_payment_status', ['pending', 'cleared', 'voided']);
export const billPaymentMethodEnum = pgEnum('bill_payment_method', [
  'check', 'ach', 'wire', 'credit_card', 'bill_pay_provider', 'cash', 'other',
]);

export const bills = pgTable(
  'bills',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    billNumber: text('bill_number'),
    billDate: date('bill_date').notNull(),
    dueDate: date('due_date').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    balanceCents: bigint('balance_cents', { mode: 'number' }).notNull(),
    apGlAccountId: uuid('ap_gl_account_id')
      .notNull()
      .references(() => glAccounts.id, { onDelete: 'restrict' }),
    status: billStatusEnum('status').notNull().default('draft'),
    memo: text('memo'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),
    sourceBillId: text('source_bill_id'),
    sourcePms: text('source_pms').notNull().default('appfolio'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgIdx: index('bills_org_idx').on(t.organizationId),
    vendorIdx: index('bills_vendor_idx').on(t.vendorId),
    statusIdx: index('bills_status_idx').on(t.organizationId, t.status),
    dueIdx: index('bills_due_idx').on(t.organizationId, t.dueDate),
    sourceIdx: index('bills_source_idx').on(t.sourceBillId),
  }),
);

export const billLines = pgTable(
  'bill_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    billId: uuid('bill_id')
      .notNull()
      .references(() => bills.id, { onDelete: 'cascade' }),
    lineNumber: integer('line_number').notNull(),
    glAccountId: uuid('gl_account_id')
      .notNull()
      .references(() => glAccounts.id, { onDelete: 'restrict' }),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    memo: text('memo'),
    propertyId: uuid('property_id').references(() => properties.id, { onDelete: 'set null' }),
    unitId: uuid('unit_id').references(() => units.id, { onDelete: 'set null' }),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    billLineUniq: uniqueIndex('bill_lines_line_number_uniq').on(t.billId, t.lineNumber),
    billIdx: index('bill_lines_bill_idx').on(t.billId),
    orgIdx: index('bill_lines_org_idx').on(t.organizationId),
    propertyIdx: index('bill_lines_property_idx').on(t.propertyId),
    entityIdx: index('bill_lines_entity_idx').on(t.entityId),
  }),
);

export const billPayments = pgTable(
  'bill_payments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    paymentDate: date('payment_date').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    paymentMethod: billPaymentMethodEnum('payment_method').notNull(),
    bankAccountId: uuid('bank_account_id').references(() => bankAccounts.id, {
      onDelete: 'set null',
    }),
    externalReference: text('external_reference'),
    journalEntryId: uuid('journal_entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'restrict' }),
    status: billPaymentStatusEnum('status').notNull().default('cleared'),
    memo: text('memo'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgIdx: index('bill_payments_org_idx').on(t.organizationId),
    vendorIdx: index('bill_payments_vendor_idx').on(t.vendorId),
    bankIdx: index('bill_payments_bank_idx').on(t.bankAccountId),
    statusIdx: index('bill_payments_status_idx').on(t.organizationId, t.status),
    dateIdx: index('bill_payments_date_idx').on(t.organizationId, t.paymentDate),
    refIdx: index('bill_payments_ref_idx').on(t.externalReference),
  }),
);

export const billPaymentAllocations = pgTable(
  'bill_payment_allocations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    billPaymentId: uuid('bill_payment_id')
      .notNull()
      .references(() => billPayments.id, { onDelete: 'cascade' }),
    billId: uuid('bill_id')
      .notNull()
      .references(() => bills.id, { onDelete: 'restrict' }),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex('bill_payment_allocations_uniq').on(t.billPaymentId, t.billId),
    paymentIdx: index('bpa_payment_idx').on(t.billPaymentId),
    billIdx: index('bpa_bill_idx').on(t.billId),
  }),
);

// `sql` kept for future schema helpers; suppress unused-import lint.
void sql;
