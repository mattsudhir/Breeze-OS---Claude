// admin_error_log — every /api/admin/* error captured by
// withAdminHandler. See migration 0032. Org-less by design: some
// errors happen before getDefaultOrgId() resolves.

import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export const adminErrorLog = pgTable(
  'admin_error_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    path: text('path').notNull(),
    method: text('method').notNull(),
    status: integer('status'),
    message: text('message').notNull(),
    stack: text('stack'),
    context: jsonb('context'),
  },
  (t) => ({
    createdIdx: index('admin_error_log_created_idx').on(t.createdAt),
  }),
);
