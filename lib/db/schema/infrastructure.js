// Cross-cutting infrastructure: Vapi calls, the generic scheduled-task
// queue, and the append-only audit log. These tables are referenced by
// many domains but don't belong to any one of them.

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

import { organizations } from './core.js';

// ── Enums ────────────────────────────────────────────────────────

export const callPurposeEnum = pgEnum('call_purpose', [
  'move_event_utility',
  'tenant_collection',
  'generic',
]);

export const callStatusEnum = pgEnum('call_status', [
  'queued',
  'ringing',
  'in_progress',
  'on_hold',
  'completed',
  'failed',
  'no_answer',
]);

export const callOutcomeEnum = pgEnum('call_outcome', [
  'success',
  'partial',
  'on_hold_timeout',
  'closed',
  'needs_human',
  'failed',
  'voicemail',
]);

export const taskStatusEnum = pgEnum('task_status', [
  'pending',
  'claimed',
  'completed',
  'failed',
  'cancelled',
]);

// ── Tables ───────────────────────────────────────────────────────

// Every Vapi call. The related_table / related_id polymorphic pointer
// lets a call belong to any workflow (move-event utilities today, other
// purposes later) without adding N nullable FKs.
export const calls = pgTable(
  'calls',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    purpose: callPurposeEnum('purpose').notNull(),
    relatedTable: text('related_table'), // e.g. 'move_event_utilities'
    relatedId: uuid('related_id'), // polymorphic FK, no DB-level constraint
    vapiCallId: text('vapi_call_id'), // Vapi's call UUID, set once created
    toPhone: text('to_phone').notNull(), // E.164
    fromPhone: text('from_phone'), // E.164 of the configured Vapi number
    status: callStatusEnum('status').notNull().default('queued'),
    outcome: callOutcomeEnum('outcome'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationSeconds: integer('duration_seconds'),
    costCents: integer('cost_cents'),
    transcript: text('transcript'),
    recordingUrl: text('recording_url'),
    // Vapi structured-output JSON returned by the assistant at end-of-call.
    structuredOutput: jsonb('structured_output'),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgIdx: index('calls_org_idx').on(t.organizationId),
    vapiIdx: index('calls_vapi_idx').on(t.vapiCallId),
    relatedIdx: index('calls_related_idx').on(t.relatedTable, t.relatedId),
  }),
);

// Generic scheduled work queue. The Vercel cron runs every 5 min and
// drains pending rows whose scheduled_for is <= now(). SKIP LOCKED
// semantics handled at query time — see lib/db/tasks.js.
export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // 'retry_move_event_utility' | ...
    payload: jsonb('payload').notNull(),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    status: taskStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    dueIdx: index('tasks_due_idx').on(t.status, t.scheduledFor),
  }),
);

// Append-only audit trail. Every meaningful state transition writes
// a row here — move event status changes, utility transfers, call
// outcomes, user actions. Essential for compliance and debugging.
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    actorType: text('actor_type').notNull(), // user | system | vapi_webhook | cron
    actorId: text('actor_id'), // user UUID, or a system identifier
    subjectTable: text('subject_table').notNull(),
    subjectId: uuid('subject_id').notNull(),
    eventType: text('event_type').notNull(), // e.g. 'status_changed'
    beforeState: jsonb('before_state'),
    afterState: jsonb('after_state'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgIdx: index('audit_events_org_idx').on(t.organizationId),
    subjectIdx: index('audit_events_subject_idx').on(t.subjectTable, t.subjectId),
  }),
);
