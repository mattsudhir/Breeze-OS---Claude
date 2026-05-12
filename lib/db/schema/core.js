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
} from 'drizzle-orm/pg-core';

export const organizations = pgTable('organizations', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
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
