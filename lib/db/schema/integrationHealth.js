// Integration health — proactive monitoring for every external system.
// See migration 0030.

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations } from './core.js';

export const integrationHealthStatusEnum = pgEnum('integration_health_status', [
  'ok',
  'degraded',
  'down',
  'unknown',
]);

export const integrationHealth = pgTable(
  'integration_health',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    displayName: text('display_name').notNull(),
    status: integrationHealthStatusEnum('status').notNull().default('unknown'),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    lastErrorMessage: text('last_error_message'),
    lastProbeAt: timestamp('last_probe_at', { withTimezone: true }),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    consecutiveSuccesses: integer('consecutive_successes').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgNameUniq: uniqueIndex('integration_health_org_name_uniq').on(t.organizationId, t.name),
    statusIdx: index('integration_health_status_idx').on(t.organizationId, t.status),
  }),
);
