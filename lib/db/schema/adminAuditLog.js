// admin_audit_log — append-only audit trail for /api/admin/*
// writes. See migration 0034. Populated explicitly by endpoint
// handlers via the recordAudit() helper in adminHelpers.js.

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export const adminAuditLog = pgTable(
  'admin_audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),

    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),

    path: text('path').notNull(),
    method: text('method').notNull(),

    action: text('action').notNull(),
    targetTable: text('target_table'),
    targetId: text('target_id'),

    before: jsonb('before'),
    after: jsonb('after'),
    diff: jsonb('diff'),

    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    context: jsonb('context'),
  },
  (t) => ({
    createdIdx: index('admin_audit_log_created_idx').on(t.createdAt),
    tableIdIdx: index('admin_audit_log_table_id_idx').on(t.targetTable, t.targetId),
    actorIdx: index('admin_audit_log_actor_idx').on(t.actorType, t.actorId),
  }),
);
