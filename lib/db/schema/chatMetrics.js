// chat_metrics — pre-computed answers to common chat questions.
// See migration 0037 + ADR 0006.

import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  jsonb,
  timestamp,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';
import { organizations } from './core.js';

export const chatMetrics = pgTable(
  'chat_metrics',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    metricKey: text('metric_key').notNull(),
    scopeType: text('scope_type').notNull().default('org'),
    scopeId: text('scope_id').notNull().default(''),
    value: jsonb('value').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    stale: boolean('stale').notNull().default(false),
    dirtyAt: timestamp('dirty_at', { withTimezone: true }),
    computeMs: integer('compute_ms'),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.organizationId, t.metricKey, t.scopeType, t.scopeId],
    }),
    dirtyIdx: index('chat_metrics_dirty_idx').on(t.stale, t.dirtyAt),
    keyIdx: index('chat_metrics_key_idx').on(t.organizationId, t.metricKey),
    computedAtIdx: index('chat_metrics_computed_at_idx').on(
      t.organizationId,
      t.computedAt,
    ),
  }),
);
