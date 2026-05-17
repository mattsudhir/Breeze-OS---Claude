// briefing_runs — bookkeeping for the daily-briefing feature.
// See migration 0036 + ADR 0005.

import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { organizations, entities } from './core.js';

export const briefingRuns = pgTable(
  'briefing_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    organizationId: uuid('organization_id')
      .references(() => organizations.id, { onDelete: 'cascade' }),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    entityId: uuid('entity_id')
      .references(() => entities.id, { onDelete: 'set null' }),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
    signals: jsonb('signals').notNull(),
    model: text('model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
  },
  (t) => ({
    actorIdx: index('briefing_runs_actor_idx').on(t.actorType, t.actorId, t.createdAt),
    orgIdx: index('briefing_runs_org_idx').on(t.organizationId, t.createdAt),
  }),
);
