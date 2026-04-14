// Breeze OS database schema (Drizzle / Postgres).
//
// Every user-facing table carries an organization_id so we can enforce
// tenancy isolation at the query layer from day one. Adding it later is
// painful — every row already has it now.
//
// Multi-tenancy is optional at the app level for now (only one org will
// exist), but the constraint exists so no code can forget about it.

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';

// ── Enums ────────────────────────────────────────────────────────

export const propertyTypeEnum = pgEnum('property_type', [
  'sfr',
  'multi_family',
  'commercial',
  'mixed',
]);

export const utilityTypeEnum = pgEnum('utility_type', [
  'electric',
  'gas',
  'water',
  'sewer',
  'trash',
  'internet',
  'cable',
]);

// Who's supposed to hold the account for this utility at this property
// in the steady state (tenant-occupied).
//
//   owner_llc — LLC keeps the account; Breeze-managed
//   tenant    — tenant is expected to have it in their own name
//   none      — this utility isn't supplied at the property at all
//                (no gas service, no municipal sewer, etc.).
//                Stored explicitly so "no gas here" is distinguishable
//                from "haven't configured gas yet."
export const accountHolderEnum = pgEnum('account_holder', [
  'owner_llc',
  'tenant',
  'none',
]);

// How a billed-back utility is distributed to tenants.
//
//   none         — no billback (either tenant pays directly, or LLC absorbs)
//   full         — the full bill is charged to one tenant's ledger
//   split_meter  — one shared meter covers multiple units; bill is split
//                  evenly across units (typical of duplex water when the
//                  utility only provides a single meter for both sides)
//
// Future values the enum may grow into:
//   split_by_sqft       — proportional to each unit's square footage
//   split_by_occupancy  — proportional to number of occupants
//   custom              — manual per-unit amounts, entered by staff
//
// billback_tenant (the legacy boolean) stays in sync as a shadow for
// backward-compat with existing code paths. New code should prefer
// reading billback_mode.
export const billbackModeEnum = pgEnum('billback_mode', [
  'none',
  'full',
  'split_meter',
]);

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

// ── Core ─────────────────────────────────────────────────────────

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

// ── Property directory ───────────────────────────────────────────

// The LLC that owns one or more properties. Utility accounts for
// LLC-held utilities (water, trash, sometimes electric/gas) live under
// this entity's legal name.
export const owners = pgTable(
  'owners',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    legalName: text('legal_name').notNull(), // "Breeze Holdings Toledo Ohio LLC"
    dba: text('dba'), // doing-business-as, optional
    // EIN stored via pgcrypto's pgp_sym_encrypt. We write/read this via
    // the db helpers in lib/db/encryption.js so plaintext never touches
    // application code. See the column initialiser for details.
    einEncrypted: text('ein_encrypted'),
    mailingAddressLine1: text('mailing_address_line1'),
    mailingAddressLine2: text('mailing_address_line2'),
    mailingCity: text('mailing_city'),
    mailingState: text('mailing_state'), // 2-char postal code
    mailingZip: text('mailing_zip'),
    billingEmail: text('billing_email'),
    // Authorised caller list: people the utility has on file as allowed
    // to speak for the LLC. The AI references these by name, never
    // impersonates them.
    //   [{ name: string, title?: string, phone?: string }, ...]
    authorizedCallers: jsonb('authorized_callers'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgIdx: index('owners_org_idx').on(t.organizationId),
  }),
);

export const properties = pgTable(
  'properties',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, { onDelete: 'restrict' }),
    // Stable external property ID from the source PMS (originally the
    // Appfolio property ID for Breeze's imported data). The column was
    // renamed from rm_property_id in migration 0003.
    sourcePropertyId: integer('source_property_id'),
    // Which PMS the source_property_id came from. Defaults to
    // 'appfolio' for all existing data; future imports from other
    // systems set this explicitly.
    sourcePms: text('source_pms').notNull().default('appfolio'),
    displayName: text('display_name').notNull(),
    propertyType: propertyTypeEnum('property_type').notNull().default('sfr'),
    // Service address — where the meters are.
    serviceAddressLine1: text('service_address_line1').notNull(),
    serviceAddressLine2: text('service_address_line2'),
    serviceCity: text('service_city').notNull(),
    serviceState: text('service_state').notNull(),
    serviceZip: text('service_zip').notNull(),
    // Billing address — where utility bills are mailed / emailed to.
    // Often differs from the service address for LLC-held utilities
    // (bills go to the LLC's mailing PO box, not the rental unit).
    // Leave blank to fall back to the owner's mailing address.
    billingAddressLine1: text('billing_address_line1'),
    billingAddressLine2: text('billing_address_line2'),
    billingCity: text('billing_city'),
    billingState: text('billing_state'),
    billingZip: text('billing_zip'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgIdx: index('properties_org_idx').on(t.organizationId),
    ownerIdx: index('properties_owner_idx').on(t.ownerId),
    sourceIdx: index('properties_source_idx').on(t.sourcePropertyId),
  }),
);

// Individual rentable units within a property. For SFRs this is usually
// a single row whose name mirrors the street address; for multi-family
// buildings it's one row per unit. Move-events, utility accounts, and
// tenants all ultimately attach to units rather than properties when
// the data granularity supports it.
export const units = pgTable(
  'units',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    // Human label — "Unit 101", "Apt 3", "Upper", "1111 Orchard St" for
    // SFRs. Not globally unique; scoped by property_id. Renamed from
    // rm_unit_name in migration 0003.
    sourceUnitName: text('source_unit_name'),
    // Stable external unit ID from the source PMS (Appfolio Unit ID for
    // Breeze's imported data). Nullable until backfilled; populated via
    // /api/admin/backfill-unit-ids for existing rows, set at insert
    // time for new imports.
    sourceUnitId: text('source_unit_id'),
    // Which PMS the source IDs came from. See notes on properties.sourcePms.
    sourcePms: text('source_pms').notNull().default('appfolio'),
    sqft: integer('sqft'),
    bedrooms: integer('bedrooms'),
    // Bathrooms can be decimal (1.5, 2.5) — stored as text to preserve
    // whatever fractional format the source system used without having
    // to pick a numeric precision up front.
    bathrooms: text('bathrooms'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    propertyIdx: index('units_property_idx').on(t.propertyId),
    orgIdx: index('units_org_idx').on(t.organizationId),
  }),
);

// Per-property (optionally per-unit) utility configuration — the source
// of truth for "who's supposed to hold this utility" and "which provider
// services it".
//
// unit_id is nullable: NULL means the utility row applies to the whole
// property (shared meter, LLC-level account). A set unit_id scopes the
// row to that specific unit (individually-metered apartment building).
export const propertyUtilities = pgTable(
  'property_utilities',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    unitId: uuid('unit_id').references(() => units.id, { onDelete: 'cascade' }),
    utilityType: utilityTypeEnum('utility_type').notNull(),
    providerId: uuid('provider_id').references(() => utilityProviders.id, {
      onDelete: 'set null',
    }),
    accountHolder: accountHolderEnum('account_holder').notNull(),
    // Legacy boolean — kept in sync with billback_mode for backward
    // compatibility. True whenever billback_mode is 'full' or
    // 'split_meter'. New code should read billback_mode instead;
    // this column will be dropped once all callers are migrated.
    billbackTenant: boolean('billback_tenant').notNull().default(false),
    // Richer billback classification. See billbackModeEnum docs above.
    // The Grid Import parser accepts 'none' / 'full' / 'split_meter'
    // as well as the friendlier aliases 'n' / 'y' / 'yes-meter_split'.
    billbackMode: billbackModeEnum('billback_mode').notNull().default('none'),
    // The current account number as known to us. Updated by workflows
    // when transfers succeed; editable manually for initial seeding.
    currentAccountNumber: text('current_account_number'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    propertyIdx: index('property_utilities_property_idx').on(t.propertyId),
    unitIdx: index('property_utilities_unit_idx').on(t.unitId),
    providerIdx: index('property_utilities_provider_idx').on(t.providerId),
  }),
);

// Per-utility-company playbook. The AI calls these directly; the
// call_script_notes + required_fields shape the per-call system prompt.
export const utilityProviders = pgTable(
  'utility_providers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(), // "Columbia Gas of Ohio"
    // Nullable — providers can be seeded without a verified phone
    // number. The move-event worker escalates to needs_human when a
    // call is attempted against a provider without a phone on file.
    phoneNumber: text('phone_number'), // E.164 when set
    website: text('website'),
    // Business hours as { mon: [openHour, closeHour], ... } in the
    // provider's local timezone. null entries mean "closed that day".
    //   { timezone, mon: [8, 17], tue: [8, 17], ..., sat: null, sun: null }
    businessHours: jsonb('business_hours'),
    expectedHoldMinutes: integer('expected_hold_minutes').default(5),
    callScriptNotes: text('call_script_notes'), // free text prompt hints
    // Data the agent must provide for this provider, e.g.
    //   ["ein_last4", "prior_account_number", "service_address"]
    requiredFields: jsonb('required_fields'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgIdx: index('utility_providers_org_idx').on(t.organizationId),
  }),
);

// ── Move events ──────────────────────────────────────────────────

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

// ── Infrastructure: calls, tasks, audit ──────────────────────────

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
