// Move-events — one row per tenant move-in / move-out, plus the
// per-utility action list each event produces. Drives the move-event
// worker that calls utility providers via Vapi to verify or transfer
// service.

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  integer,
  index,
} from 'drizzle-orm/pg-core';

import { organizations } from './core.js';
import { properties } from './directory.js';
import { propertyUtilities } from './directory.js';
import { users } from './core.js';

// ── Enums ────────────────────────────────────────────────────────

export const moveEventTypeEnum = pgEnum('move_event_type', [
  'move_in',
  'move_out',
]);

export const moveEventStatusEnum = pgEnum('move_event_status', [
  'pending',
  'in_progress',
  'completed',
  'escalated',
  'cancelled',
]);

// What the move-event worker needs to DO for a given utility.
//
//   verify_off_llc    — Move-in: confirm the utility is NOT in the LLC's name
//                        anymore (tenant should have switched it to their
//                        own account). If still on the LLC after the grace
//                        period, escalate.
//   transfer_to_llc   — Move-out: close the tenant's account (or leave it
//                        terminated) and open a new account in the LLC's
//                        name effective the move-out date.
//   verify_on_llc     — Routine: confirm the utility IS on the LLC's name
//                        (used for utilities that always stay with the LLC
//                        like water/trash — rarely triggers a call, mostly
//                        bookkeeping).
export const moveEventActionEnum = pgEnum('move_event_action', [
  'verify_off_llc',
  'transfer_to_llc',
  'verify_on_llc',
]);

export const moveEventItemStatusEnum = pgEnum('move_event_item_status', [
  'pending',
  'calling',
  'on_hold',
  'completed',
  'failed',
  'needs_human',
]);

// ── Tables ───────────────────────────────────────────────────────

// One row per move-in / move-out. The business rules the user laid out:
//
//   MOVE-IN:  tenant is supposed to switch utilities into their own name.
//             We verify the utility is OFF our LLC. If still on it after
//             a grace period, escalate for a human to chase.
//
//   MOVE-OUT: tenant is leaving; we need to switch utilities BACK into
//             the LLC's name so service continues without interruption.
//             This is the active-transfer workflow.
export const moveEvents = pgTable(
  'move_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    // External tenant ID from the source PMS. Renamed from rm_tenant_id
    // in migration 0003.
    sourceTenantId: integer('source_tenant_id'),
    sourcePms: text('source_pms').notNull().default('appfolio'),
    tenantDisplayName: text('tenant_display_name'), // snapshot, in case source record changes
    eventType: moveEventTypeEnum('event_type').notNull(),
    effectiveDate: timestamp('effective_date', { withTimezone: true }).notNull(),
    status: moveEventStatusEnum('status').notNull().default('pending'),
    notes: text('notes'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgIdx: index('move_events_org_idx').on(t.organizationId),
    propertyIdx: index('move_events_property_idx').on(t.propertyId),
    sourceTenantIdx: index('move_events_source_tenant_idx').on(t.sourceTenantId),
  }),
);

// Per-utility action required to complete a move event. One row per
// utility that needs verification or transfer. A typical SFR move-in
// might create 2 rows (verify electric off LLC, verify gas off LLC),
// skipping water/trash/sewer entirely.
export const moveEventUtilities = pgTable(
  'move_event_utilities',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    moveEventId: uuid('move_event_id')
      .notNull()
      .references(() => moveEvents.id, { onDelete: 'cascade' }),
    propertyUtilityId: uuid('property_utility_id')
      .notNull()
      .references(() => propertyUtilities.id, { onDelete: 'restrict' }),
    action: moveEventActionEnum('action').notNull(),
    status: moveEventItemStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    // Account numbers around the transfer. For verify_off_llc, fromAccount
    // is the LLC's old number and toAccount is whatever the tenant set up.
    fromAccountNumber: text('from_account_number'),
    toAccountNumber: text('to_account_number'),
    confirmationNumber: text('confirmation_number'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    moveEventIdx: index('move_event_utilities_move_event_idx').on(t.moveEventId),
    statusIdx: index('move_event_utilities_status_idx').on(t.status),
  }),
);
