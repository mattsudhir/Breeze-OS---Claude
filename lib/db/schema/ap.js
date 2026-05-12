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
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './core.js';
import { glAccounts } from './accounting.js';

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
