// Core organizational primitives — organizations + users.
//
// Every other table in the schema FKs back to organizations.id for
// tenancy isolation. The users table is a placeholder until Clerk
// auth lands in a follow-up PR; for now a row here represents a
// shared-secret admin principal.

import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  real,
  integer,
  boolean,
  date,
  pgEnum,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ── Legal entities ──────────────────────────────────────────────
//
// A landlord rarely owns property in their personal name; they own
// through LLCs (often one per property). entities is the layer
// between organizations and properties — properties.entity_id (added
// in migration 0019) maps each property to its owning entity, and
// journal_lines.entity_id (same migration) becomes the dimension
// that drives per-entity P&L and consolidated reports.

export const entityTypeEnum = pgEnum('entity_type', [
  'llc',
  'corp',
  'partnership',
  'sole_prop',
  'trust',
  'individual',
]);

export const organizations = pgTable('organizations', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  // ── Reconciliation auto-match thresholds (per-org) ──────────────
  // Minimum confidence_score and minimum rule.times_used required
  // for a match_candidate to land as `auto_matched` instead of
  // `pending_review`. Defaults preserve historic behavior (0.95 / 5).
  reconAutoMatchConfidence: real('recon_auto_match_confidence').notNull().default(0.95),
  reconAutoMatchMinTimesUsed: integer('recon_auto_match_min_times_used').notNull().default(5),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const entities = pgTable(
  'entities',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    legalName: text('legal_name'),
    entityType: entityTypeEnum('entity_type').notNull(),
    // EIN / SSN encrypted via lib/encryption.js (AES-256-GCM, same
    // "iv:tag:ciphertext" hex format as owners.ein_encrypted).
    taxIdEncrypted: text('tax_id_encrypted'),
    taxIdLast4: text('tax_id_last4'),
    formationState: text('formation_state'),
    formationDate: date('formation_date'),
    fiscalYearEndMonth: integer('fiscal_year_end_month').notNull().default(12),
    isActive: boolean('is_active').notNull().default(true),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgIdx: index('entities_org_idx').on(t.organizationId),
    // Active-only soft-unique on display name. Matches the partial
    // unique index from migration 0019.
    orgNameUniq: uniqueIndex('entities_org_name_uniq')
      .on(t.organizationId, sql`lower(${t.name})`)
      .where(sql`${t.isActive} = true`),
  }),
);

// Users table — placeholder until Clerk auth lands in a follow-up PR.
// For now, a row here represents a shared-secret admin principal.
export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    displayName: text('display_name'),
    role: text('role').notNull().default('admin'), // admin | staff | viewer
    clerkUserId: text('clerk_user_id'), // populated when Clerk lands
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgIdx: index('users_org_idx').on(t.organizationId),
    emailIdx: index('users_email_idx').on(t.email),
  }),
);
