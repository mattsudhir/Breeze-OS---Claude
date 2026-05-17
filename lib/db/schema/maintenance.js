// Maintenance tickets — the work-order layer of Breeze OS.
//
// Schema from migration 0029. A ticket is anchored to a property
// (and optionally a unit + tenant), assigned to a vendor when work
// is dispatched, and rolls forward through a status flow. Comments
// give a unified timeline (tenant updates, staff notes, vendor
// confirmations, AI triage).

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  bigint,
  boolean,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { organizations } from './core.js';
import { properties, units } from './directory.js';
import { vendors } from './ap.js';

export const maintenanceTicketStatusEnum = pgEnum('maintenance_ticket_status', [
  'new',
  'triage',
  'assigned',
  'in_progress',
  'awaiting_parts',
  'awaiting_tenant',
  'completed',
  'cancelled',
]);

export const maintenanceTicketPriorityEnum = pgEnum('maintenance_ticket_priority', [
  'low',
  'medium',
  'high',
  'emergency',
]);

export const maintenanceCommentAuthorTypeEnum = pgEnum('maintenance_comment_author_type', [
  'staff', 'tenant', 'vendor', 'ai', 'system',
]);

export const maintenanceTickets = pgTable(
  'maintenance_tickets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id').references(() => properties.id, { onDelete: 'set null' }),
    unitId: uuid('unit_id').references(() => units.id, { onDelete: 'set null' }),
    tenantId: uuid('tenant_id'),
    vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'set null' }),
    assignedToUserId: uuid('assigned_to_user_id'),
    title: text('title').notNull(),
    // Where the title came from. See ADR 0004 + migration 0035.
    // 'raw' | 'first_sentence' | 'ai_summary' | 'manual_edit'.
    // The sync (sync-appfolio-tickets.js) treats 'manual_edit' as
    // sacred and skips title updates for those rows.
    titleSource: text('title_source').notNull().default('first_sentence'),
    description: text('description'),
    category: text('category'),
    priority: maintenanceTicketPriorityEnum('priority').notNull().default('medium'),
    status: maintenanceTicketStatusEnum('status').notNull().default('new'),
    reportedAt: timestamp('reported_at', { withTimezone: true }).defaultNow().notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    estimatedCostCents: bigint('estimated_cost_cents', { mode: 'number' }),
    actualCostCents: bigint('actual_cost_cents', { mode: 'number' }),
    billId: uuid('bill_id'),
    sourceTicketId: text('source_ticket_id'),
    sourcePms: text('source_pms').notNull().default('breeze'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgIdx: index('maintenance_tickets_org_idx').on(t.organizationId),
    propertyIdx: index('maintenance_tickets_property_idx').on(t.propertyId),
    unitIdx: index('maintenance_tickets_unit_idx').on(t.unitId),
    tenantIdx: index('maintenance_tickets_tenant_idx').on(t.tenantId),
    vendorIdx: index('maintenance_tickets_vendor_idx').on(t.vendorId),
    statusIdx: index('maintenance_tickets_status_idx').on(t.organizationId, t.status),
    priorityIdx: index('maintenance_tickets_priority_idx').on(t.organizationId, t.priority),
    sourceIdx: index('maintenance_tickets_source_idx').on(t.sourceTicketId),
  }),
);

export const maintenanceTicketComments = pgTable(
  'maintenance_ticket_comments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => maintenanceTickets.id, { onDelete: 'cascade' }),
    authorType: maintenanceCommentAuthorTypeEnum('author_type').notNull(),
    authorId: uuid('author_id'),
    authorDisplay: text('author_display'),
    body: text('body').notNull(),
    isInternal: boolean('is_internal').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    ticketIdx: index('maintenance_ticket_comments_ticket_idx').on(t.ticketId),
    orgIdx: index('maintenance_ticket_comments_org_idx').on(t.organizationId),
  }),
);
