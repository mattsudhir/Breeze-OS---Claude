// Messaging foundation — unified inbox/outbox across SMS, email, voice.
//
// Drizzle definitions for migration 0022_messaging.sql.

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations } from './core.js';
import { properties } from './directory.js';

export const messageChannelEnum   = pgEnum('message_channel',   ['sms', 'email', 'voice']);
export const messageDirectionEnum = pgEnum('message_direction', ['inbound', 'outbound']);
export const messageStatusEnum    = pgEnum('message_status', [
  'queued', 'sending', 'sent', 'delivered',
  'answered', 'no_answer', 'failed', 'opt_out',
]);

// How much the AI is allowed to do without a human in the loop.
// Set per-org (organizations.ai_default_autonomy_level) and
// overridable per-workflow (ai_workflows.autonomy_level).
export const aiAutonomyLevelEnum = pgEnum('ai_autonomy_level', [
  'draft_only',
  'approve_before_contact',
  'approve_before_action',
  'notify_only',
  'full',
]);

// ── message_threads ─────────────────────────────────────────────

export const messageThreads = pgTable(
  'message_threads',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id'),
    propertyId: uuid('property_id').references(() => properties.id, { onDelete: 'set null' }),
    leaseId: uuid('lease_id'),
    subject: text('subject'),
    // Sticky from-phone-number — every outbound to this thread comes
    // from this number once set (added in migration 0025). FK is
    // declared lazily because phoneNumbers is defined later in this
    // file; Drizzle resolves it via the lambda.
    fromPhoneNumberId: uuid('from_phone_number_id'),
    // AI is paused on this thread — staff is handling replies.
    staffPaused: boolean('staff_paused').notNull().default(false),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgIdx: index('message_threads_org_idx').on(t.organizationId),
    tenantIdx: index('message_threads_tenant_idx').on(t.tenantId),
    propertyIdx: index('message_threads_property_idx').on(t.propertyId),
    fromPhoneIdx: index('message_threads_from_phone_idx').on(t.fromPhoneNumberId),
  }),
);

// ── messages ────────────────────────────────────────────────────

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id').references(() => messageThreads.id, { onDelete: 'set null' }),
    channel: messageChannelEnum('channel').notNull(),
    direction: messageDirectionEnum('direction').notNull(),
    status: messageStatusEnum('status').notNull().default('queued'),
    tenantId: uuid('tenant_id'),
    propertyId: uuid('property_id').references(() => properties.id, { onDelete: 'set null' }),
    leaseId: uuid('lease_id'),
    fromAddress: text('from_address'),
    toAddress: text('to_address'),
    subject: text('subject'),
    body: text('body'),
    aiWorkflowId: uuid('ai_workflow_id'),
    externalId: text('external_id'),
    errorMessage: text('error_message'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgIdx: index('messages_org_idx').on(t.organizationId),
    threadIdx: index('messages_thread_idx').on(t.threadId),
    tenantIdx: index('messages_tenant_idx').on(t.tenantId),
    externalIdx: index('messages_external_idx').on(t.externalId),
    workflowIdx: index('messages_workflow_idx').on(t.aiWorkflowId),
  }),
);

// ── voice_calls ─────────────────────────────────────────────────

export const voiceCalls = pgTable(
  'voice_calls',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    vapiCallId: text('vapi_call_id'),
    vapiAssistantId: text('vapi_assistant_id'),
    durationSec: integer('duration_sec'),
    recordingUrl: text('recording_url'),
    transcriptJson: jsonb('transcript_json'),
    functionCallsJson: jsonb('function_calls_json'),
    endReason: text('end_reason'),
    costCents: integer('cost_cents'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgIdx: index('voice_calls_org_idx').on(t.organizationId),
    vapiIdx: index('voice_calls_vapi_idx').on(t.vapiCallId),
  }),
);

// ── ai_workflows ────────────────────────────────────────────────

export const aiWorkflows = pgTable(
  'ai_workflows',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    channel: messageChannelEnum('channel').notNull(),
    direction: messageDirectionEnum('direction').notNull(),
    vapiAssistantId: text('vapi_assistant_id'),
    triggerType: text('trigger_type'),
    triggerConfig: jsonb('trigger_config'),
    // Null inherits organizations.ai_default_autonomy_level.
    autonomyLevel: aiAutonomyLevelEnum('autonomy_level'),
    isActive: boolean('is_active').notNull().default(true),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgSlugUniq: uniqueIndex('ai_workflows_org_slug_uniq').on(t.organizationId, t.slug),
    orgActiveIdx: index('ai_workflows_org_active_idx').on(t.organizationId, t.isActive),
  }),
);

// ── Phone numbers (0025) ────────────────────────────────────────

export const phoneNumberPurposeEnum = pgEnum('phone_number_purpose', [
  'org_main', 'property_main', 'support', 'collections', 'maintenance', 'voice_only',
]);

export const phoneNumbers = pgTable(
  'phone_numbers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id').references(() => properties.id, { onDelete: 'set null' }),
    twilioSid: text('twilio_sid'),
    e164Number: text('e164_number').notNull(),
    purpose: phoneNumberPurposeEnum('purpose').notNull().default('org_main'),
    capabilities: jsonb('capabilities'),
    isActive: boolean('is_active').notNull().default(true),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgIdx: index('phone_numbers_org_idx').on(t.organizationId),
    propertyIdx: index('phone_numbers_property_idx').on(t.propertyId),
    e164Uniq: uniqueIndex('phone_numbers_e164_uniq').on(t.e164Number),
  }),
);

// ── Tenant phone aliases ────────────────────────────────────────

export const tenantPhoneAliases = pgTable(
  'tenant_phone_aliases',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id').notNull(),
    phoneE164: text('phone_e164').notNull(),
    label: text('label'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex('tenant_phone_aliases_uniq').on(t.organizationId, t.phoneE164),
    tenantIdx: index('tenant_phone_aliases_tenant_idx').on(t.tenantId),
  }),
);

// ── Per-channel consent ────────────────────────────────────────

export const communicationConsentStatusEnum = pgEnum('communication_consent_status', [
  'active', 'opted_out', 'unknown',
]);

export const tenantCommunicationConsents = pgTable(
  'tenant_communication_consents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id').notNull(),
    channel: messageChannelEnum('channel').notNull(),
    status: communicationConsentStatusEnum('status').notNull().default('active'),
    consentedAt: timestamp('consented_at', { withTimezone: true }),
    optedOutAt: timestamp('opted_out_at', { withTimezone: true }),
    optedOutViaMsg: uuid('opted_out_via_msg'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex('tenant_consent_uniq').on(t.tenantId, t.channel),
    orgIdx: index('tenant_consent_org_idx').on(t.organizationId),
  }),
);

// ── Voice call directives ──────────────────────────────────────

export const voiceCallDirectives = pgTable(
  'voice_call_directives',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    voiceCallId: uuid('voice_call_id')
      .notNull()
      .references(() => voiceCalls.id, { onDelete: 'cascade' }),
    staffUserId: uuid('staff_user_id'),
    directiveText: text('directive_text').notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    callIdx: index('voice_call_directives_call_idx').on(t.voiceCallId),
  }),
);

// ── Phone provider reconciliations ─────────────────────────────

export const phoneProviderReconciliations = pgTable(
  'phone_provider_reconciliations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    runAt: timestamp('run_at', { withTimezone: true }).defaultNow().notNull(),
    scannedWindowStart: timestamp('scanned_window_start', { withTimezone: true }).notNull(),
    scannedWindowEnd: timestamp('scanned_window_end', { withTimezone: true }).notNull(),
    matchedCount: integer('matched_count').notNull().default(0),
    insertedCount: integer('inserted_count').notNull().default(0),
    anomalies: jsonb('anomalies'),
  },
  (t) => ({
    orgIdx: index('phone_reconciliations_org_idx').on(t.organizationId),
    providerIdx: index('phone_reconciliations_provider_idx').on(t.provider, t.runAt),
  }),
);

// ── messageThreads extensions are added as columns on the
// existing pgTable definition above (Drizzle re-export is handled
// by importing the module — runtime DB has the columns from
// migration 0025; we don't redefine the table here).
