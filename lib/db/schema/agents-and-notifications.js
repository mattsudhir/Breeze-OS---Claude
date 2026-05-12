// Tables added on main while we were on the accounting branch.
// Imported here verbatim from main's pre-split schema.js so the
// merge preserves both feature streams.
//
// Tables:
//   agentActions            AI tool-invocation audit log
//   humanTasks              human task queue with SLA + status
//   issueGlMappings         maintenance-issue → GL account mapping
//                            for the Settings → GL Mapping tab
//   categorySubscriptions   per-user notification opt-in by category
//   pushSubscriptions       Web Push subscription endpoints
//   appfolioCache           Postgres mirror of AppFolio reads for
//                            sub-100ms responses
//   follows                 follow / unfollow records used by the
//                            notification fanout
//   notifications           per-user notification feed
//
// All FK back to organizations via organizationId. No new enums.
// Future split could move these into their own thematic files
// (notifications/, sync/, etc.); kept together here so the merge
// is one unit.

import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';

import { organizations, users } from './core.js';

// One row per AI tool invocation (search_tenants, charge_tenant,
// make_call, notify_team, etc.). Distinct from audit_events, which
// tracks state changes on our own tables — this is the agent's own
// action log, useful for "what did the AI do today?" / "who charged
// Frank Strehl on April 15?" queries.
//
// We capture the raw input and output JSON for forensics. Some tool
// outputs contain sensitive data (full tenant records, phone numbers);
// we accept that tradeoff because the alternative — a redacted log
// that can't tell us why a charge went wrong — is worse for incident
// response. Apply row-level access controls when this is exposed in
// a UI.
//
// Denormalised AppFolio reference IDs let us index "all actions on
// tenant X" and "audit trail for charge Y" without parsing JSONB on
// every query. They're populated opportunistically from input/output
// — the logger inspects known fields and copies them out.
export const agentActions = pgTable(
  'agent_actions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),

    // Surface that triggered the call. 'chat' = web Chat Home,
    // 'cliq' = Zoho Cliq message handler, 'cron' = scheduled task,
    // 'webhook' = AppFolio/Vapi inbound. Free-form text so we can add
    // surfaces without a migration.
    surface: text('surface').notNull(),

    // Actor identity if known. Free-form text so we can store either a
    // user UUID, an email, a Cliq user id, or 'system'. Once Breeze OS
    // has authenticated sessions this becomes a UUID lookup.
    userId: text('user_id'),

    // Optional grouping for chat sessions / Cliq threads, so the UI
    // can show "all actions in this conversation".
    conversationId: text('conversation_id'),

    // The data backend that was active when the tool ran ('appfolio',
    // 'rm-demo', 'breeze', 'zoho-mcp'). Useful when we run the same
    // tool name across backends.
    backendName: text('backend_name'),

    // The tool itself.
    toolName: text('tool_name').notNull(),
    toolInput: jsonb('tool_input').notNull(),
    toolOutput: jsonb('tool_output'),

    // Success/error. Tools return { error: '...' } on failure; we
    // unpack it here so queries like "all failed charge_tenant calls
    // last week" don't need JSONB introspection.
    success: boolean('success').notNull(),
    errorText: text('error_text'),

    // Wall-clock duration. Useful for cost/perf observability.
    durationMs: integer('duration_ms').notNull(),

    // Denormalised AppFolio ref IDs for fast lookup. Populated by the
    // logger when present in input or output. Stored as text since
    // some AppFolio IDs are UUIDs but not all of our DB rows expect
    // strict UUID format — text keeps the audit log decoupled from
    // upstream schema choices.
    appfolioTenantId: text('appfolio_tenant_id'),
    appfolioOccupancyId: text('appfolio_occupancy_id'),
    appfolioPropertyId: text('appfolio_property_id'),
    appfolioUnitId: text('appfolio_unit_id'),
    appfolioChargeId: text('appfolio_charge_id'),
    appfolioWorkOrderId: text('appfolio_work_order_id'),
  },
  (t) => ({
    orgTimeIdx: index('agent_actions_org_time_idx').on(t.organizationId, t.createdAt),
    toolTimeIdx: index('agent_actions_tool_time_idx').on(t.toolName, t.createdAt),
    tenantIdx: index('agent_actions_tenant_idx').on(t.appfolioTenantId),
    chargeIdx: index('agent_actions_charge_idx').on(t.appfolioChargeId),
    workOrderIdx: index('agent_actions_work_order_idx').on(t.appfolioWorkOrderId),
  }),
);

// Human tasks queue ("things a person needs to do").
//
// Distinct from the existing `tasks` table (which is the cron
// worker's retry queue for system-driven async work like Vapi
// callbacks). human_tasks is the user-facing inbox: payment
// allocations to apply in AppFolio, tenant requests needing PM
// review, vendor follow-ups, etc.
//
// Each task type carries its own SLA — see TASK_TYPES in
// lib/humanTasks.js. due_at is computed at create time from the
// task type's sla_hours, so changing a task type's SLA later
// affects only future tasks (existing dueAt is honored).
//
// payload jsonb stores task-type-specific data. For
// allocate_payment: { amount, method, reference, journal_entry_id,
// appfolio_url }. For charge_fee_review: { charge_id, gl_account,
// amount }.
export const humanTasks = pgTable(
  'human_tasks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    taskType: text('task_type').notNull(),
    title: text('title').notNull(),
    description: text('description'),

    relatedEntityType: text('related_entity_type'),
    relatedEntityId: text('related_entity_id'),

    assigneeUserId: text('assignee_user_id'),
    priority: text('priority').notNull().default('normal'),
    status: text('status').notNull().default('open'),

    dueAt: timestamp('due_at', { withTimezone: true }),
    slaHours: integer('sla_hours'),

    payload: jsonb('payload'),
    source: text('source').notNull().default('system'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedBy: text('completed_by'),
  },
  (t) => ({
    statusIdx: index('human_tasks_status_idx').on(
      t.organizationId, t.status, t.dueAt,
    ),
    typeIdx: index('human_tasks_type_idx').on(t.taskType),
    entityIdx: index('human_tasks_entity_idx').on(
      t.relatedEntityType, t.relatedEntityId,
    ),
    assigneeIdx: index('human_tasks_assignee_idx').on(t.assigneeUserId, t.status),
  }),
);

// Issue category → GL account mapping (Charge Fee form).
//
// One row per (org, category). The Charge Fee modal reads these to
// auto-fill the GL dropdown when the user picks Plumbing /
// Electrical / HVAC / Other instead of forcing them to scroll a
// flat list of every Repairs - … account on every charge.
export const issueGlMappings = pgTable(
  'issue_gl_mappings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    category: text('category').notNull(),
    glAccountId: text('gl_account_id'),
    glAccountName: text('gl_account_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniqueCategory: uniqueIndex('issue_gl_mappings_unique_idx').on(
      t.organizationId, t.category,
    ),
  }),
);

// Category subscriptions ("alert me on every X").
//
// Distinct from `follows` which is per-entity ("alert me about
// THIS specific tenant"). category_subscriptions are per-event-type
// ("alert me whenever ANY tenant pays rent" / "alert me on every
// new urgent work order"). Both fan out into the same notifications
// table; the bell + push delivery don't care which path produced the
// row.
//
// criteria is reserved for future per-category filters (e.g.,
// "rent payments only on properties X / Y / Z"). v1 ignores it
// — toggling a category subscribes you to every event of that
// type org-wide.
export const categorySubscriptions = pgTable(
  'category_subscriptions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    category: text('category').notNull(),
    criteria: jsonb('criteria'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniqueCategory: uniqueIndex('cat_subs_unique_idx').on(
      t.organizationId, t.userId, t.category,
    ),
    userIdx: index('cat_subs_user_idx').on(t.userId),
    categoryIdx: index('cat_subs_category_idx').on(t.category),
  }),
);

// Web push (Web Push Protocol / VAPID).
//
// Each row is one browser-installed push subscription — a user can
// have several (multiple devices, browsers). When fanoutEvent fires
// a notification, sendPushToUser looks up every row for that
// userId and pushes to each endpoint.
//
// Endpoint is unique because the browser hands us a stable URL per
// subscription; re-installing reissues a different one. Stale
// subscriptions get cleaned up automatically when the push service
// returns 404/410.
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniqueEndpoint: uniqueIndex('push_subs_endpoint_idx').on(t.endpoint),
    userIdx: index('push_subs_user_idx').on(t.userId),
  }),
);

// AppFolio mirror.
//
// AppFolio's read API is too slow for an interactive UI (1-3s per
// paginated list call, every cold start). We store a local mirror of
// each resource type we care about and serve menu-page reads from
// here instead. Two refresh paths keep the mirror current:
//
//   1. AppFolio webhooks (already wired up — PR B2). When AppFolio
//      fires a tenants / properties / units / work_orders /
//      charges / leases / leads create-update-destroy event, the
//      receiver fetches the new state by id and upserts here.
//
//   2. Periodic reconciliation cron (TBD). A small hourly job hits
//      AppFolio with filters[LastUpdatedAtFrom]=<last_run_for_type>
//      to backfill any webhook AppFolio may have dropped.
//
// Schema design:
//
// - One table for every resource type, keyed on (organizationId,
//   resourceType, resourceId). Composite PK keeps queries simple
//   and the upsert ON CONFLICT clause natural.
//
// - data jsonb holds the full canonical camelCase shape — the same
//   shape the existing list_X tools return. Reads come straight out
//   of this column so the consumer pages don't need a new mapping
//   layer.
//
// - A handful of denormalised id columns (propertyId, unitId,
//   occupancyId, status) get indexed individually so cross-cutting
//   queries like "all units in property X" or "all open work orders"
//   are sub-ms even with thousands of rows.
//
// - syncedAt tracks when we last touched a row; appfolioUpdatedAt
//   is AppFolio's own LastUpdatedAt (helps the reconciliation cron
//   identify deltas).
export const appfolioCache = pgTable(
  'appfolio_cache',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    resourceType: text('resource_type').notNull(), // 'tenant' | 'property' | 'unit' | 'work_order' | etc.
    resourceId: text('resource_id').notNull(),

    // Denormalised common fields for cross-cutting filtering.
    propertyId: text('property_id'),
    unitId: text('unit_id'),
    occupancyId: text('occupancy_id'),
    status: text('status'),
    hiddenAt: timestamp('hidden_at', { withTimezone: true }),

    // The full mapped record — canonical camelCase shape.
    data: jsonb('data').notNull(),

    // AppFolio's own LastUpdatedAt for the record. Used by the
    // reconciliation cron to grab anything modified since last run.
    appfolioUpdatedAt: timestamp('appfolio_updated_at', { withTimezone: true }),
    // When this row was last refreshed in our DB.
    syncedAt: timestamp('synced_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.organizationId, t.resourceType, t.resourceId] }),
    typeIdx: index('appfolio_cache_type_idx').on(t.organizationId, t.resourceType),
    propertyIdx: index('appfolio_cache_property_idx').on(t.resourceType, t.propertyId),
    unitIdx: index('appfolio_cache_unit_idx').on(t.resourceType, t.unitId),
    syncedIdx: index('appfolio_cache_synced_idx').on(t.resourceType, t.syncedAt),
  }),
);

// What a user is following — the source of fan-out for any event we
// want to notify them about. entity_id is whatever id that event will
// reference (for AppFolio webhooks: the AppFolio resource UUID; for
// agent-action triggers: the same AppFolio id we already denormalise
// onto agent_actions). entity_type tells the receiver what kind of
// thing it is so the UI can format and link it correctly.
//
// One follow per (user, entity) — the unique index makes "follow
// twice from two surfaces" idempotent. entity_label is denormalised
// human-readable copy ("Frank Strehl", "892 Monroe St") so the
// Following list can render without an extra round trip per row.
export const follows = pgTable(
  'follows',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    entityLabel: text('entity_label'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniqueFollow: uniqueIndex('follows_unique_idx').on(
      t.organizationId, t.userId, t.entityType, t.entityId,
    ),
    userIdx: index('follows_user_idx').on(t.userId),
    entityIdx: index('follows_entity_idx').on(t.entityType, t.entityId),
  }),
);

// User-facing event log. Created either by the AppFolio webhook
// receiver (PR B2) or by an agent-action trigger we'll wire on top
// of agent_actions (later). Read by the bell dropdown (PR B3) and
// pushed via web push (PR C).
//
// source_event_id is the AppFolio webhook event_id when source =
// 'appfolio_webhook', and used to dedup retried deliveries. Postgres
// treats NULLs as distinct in unique indexes, so non-webhook
// notifications (where source_event_id is null) are not constrained.
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),

    entityType: text('entity_type'),
    entityId: text('entity_id'),
    entityLabel: text('entity_label'),

    eventType: text('event_type'),
    source: text('source').notNull(), // 'appfolio_webhook' | 'agent_action' | 'system'

    title: text('title').notNull(),
    body: text('body'),
    linkUrl: text('link_url'),

    payload: jsonb('payload'),
    sourceEventId: text('source_event_id'),

    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userTimeIdx: index('notifications_user_time_idx').on(t.userId, t.createdAt),
    userUnreadIdx: index('notifications_user_unread_idx').on(t.userId, t.readAt),
    sourceEventIdx: uniqueIndex('notifications_source_event_idx').on(
      t.userId, t.sourceEventId,
    ),
  }),
);
