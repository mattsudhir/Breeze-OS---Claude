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
} from 'drizzle-orm/pg-core';

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
