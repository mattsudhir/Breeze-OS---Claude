-- Messaging foundation: unified inbox/outbox across SMS, email, and voice.
--
-- Three new top-level concepts:
--
--   message_threads   conversation grouping (per-tenant or per-property)
--   messages          unified row for every message sent or received,
--                     regardless of channel
--   voice_calls       per-call structured detail for the voice channel
--                     (transcript, recording, function calls)
--   ai_workflows      named AI features surfaced in the UI — each has
--                     a slug (switch_utilities, payment_plan_followup),
--                     channel, direction, and an optional VAPI
--                     assistant id. The UI's "AI Agents" menu lists
--                     active workflows; triggering a workflow places
--                     a call / sends a message tagged with the
--                     workflow id.

CREATE TYPE "message_channel"  AS ENUM ('sms', 'email', 'voice');
CREATE TYPE "message_direction" AS ENUM ('inbound', 'outbound');
CREATE TYPE "message_status"   AS ENUM (
  'queued', 'sending', 'sent', 'delivered',
  'answered', 'no_answer', 'failed', 'opt_out'
);

-- Autonomy level — how much the AI is allowed to do without a human
-- in the loop. Ordered from least to most autonomy:
--
--   draft_only             AI drafts; staff must review + send manually
--   approve_before_contact AI prepares the call/message; staff must
--                          approve before it goes out
--   approve_before_action  AI runs the conversation, but any "high
--                          risk" function call (commit payment plan,
--                          schedule utility transfer, etc.) queues for
--                          human approval before executing
--   notify_only            AI does everything; sends staff a summary
--                          for after-the-fact review
--   full                   AI does everything without notifying
--
-- Set per-org (organizations.ai_default_autonomy_level) and overridable
-- per-workflow (ai_workflows.autonomy_level). Function-call tools
-- declare their risk level; the dispatcher compares risk_level vs
-- autonomy_level to decide execute / queue / refuse.

CREATE TYPE "ai_autonomy_level" AS ENUM (
  'draft_only',
  'approve_before_contact',
  'approve_before_action',
  'notify_only',
  'full'
);

ALTER TABLE "organizations"
  ADD COLUMN "ai_default_autonomy_level" "ai_autonomy_level"
    NOT NULL DEFAULT 'approve_before_action';

-- ── message_threads ─────────────────────────────────────────────

CREATE TABLE "message_threads" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id"  uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "tenant_id"        uuid,
  "property_id"      uuid REFERENCES "properties"("id") ON DELETE SET NULL,
  "lease_id"         uuid,
  "subject"          text,
  "last_message_at"  timestamp with time zone,
  "created_at"       timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"       timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "message_threads_org_idx"      ON "message_threads"("organization_id");
CREATE INDEX "message_threads_tenant_idx"   ON "message_threads"("tenant_id");
CREATE INDEX "message_threads_property_idx" ON "message_threads"("property_id");

-- ── messages ────────────────────────────────────────────────────

CREATE TABLE "messages" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id"  uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "thread_id"        uuid REFERENCES "message_threads"("id") ON DELETE SET NULL,
  "channel"          "message_channel"  NOT NULL,
  "direction"        "message_direction" NOT NULL,
  "status"           "message_status"   NOT NULL DEFAULT 'queued',
  -- Routing dimensions (mirrors journal_lines pattern).
  "tenant_id"        uuid,
  "property_id"      uuid REFERENCES "properties"("id") ON DELETE SET NULL,
  "lease_id"         uuid,
  -- Contact info
  "from_address"     text,  -- phone (E.164) or email
  "to_address"       text,
  -- Content
  "subject"          text,
  "body"             text,  -- sms body, email body, OR call summary
  -- AI workflow tagging
  "ai_workflow_id"   uuid,
  -- Provider tracking
  "external_id"      text,  -- twilio sid, resend id, vapi call id
  "error_message"    text,
  "sent_at"          timestamp with time zone,
  "delivered_at"     timestamp with time zone,
  "created_at"       timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"       timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "messages_org_idx"      ON "messages"("organization_id");
CREATE INDEX "messages_thread_idx"   ON "messages"("thread_id");
CREATE INDEX "messages_tenant_idx"   ON "messages"("tenant_id");
CREATE INDEX "messages_external_idx" ON "messages"("external_id");
CREATE INDEX "messages_workflow_idx" ON "messages"("ai_workflow_id");

-- ── voice_calls ─────────────────────────────────────────────────

CREATE TABLE "voice_calls" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "message_id"         uuid NOT NULL REFERENCES "messages"("id") ON DELETE CASCADE,
  "organization_id"    uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "vapi_call_id"       text,
  "vapi_assistant_id"  text,
  "duration_sec"       integer,
  "recording_url"      text,
  "transcript_json"    jsonb,
  "function_calls_json" jsonb,
  "end_reason"         text,
  "cost_cents"         integer,
  "created_at"         timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "voice_calls_org_idx"  ON "voice_calls"("organization_id");
CREATE INDEX "voice_calls_vapi_idx" ON "voice_calls"("vapi_call_id");

-- ── ai_workflows ────────────────────────────────────────────────

CREATE TABLE "ai_workflows" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id"     uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "slug"                text NOT NULL,
  "name"                text NOT NULL,
  "description"         text,
  "channel"             "message_channel"  NOT NULL,
  "direction"           "message_direction" NOT NULL,
  "vapi_assistant_id"   text,
  "trigger_type"        text,        -- 'manual', 'cron', 'event:rent_late', etc.
  "trigger_config"      jsonb,
  -- Per-workflow autonomy override. NULL means inherit the org default
  -- (organizations.ai_default_autonomy_level).
  "autonomy_level"      "ai_autonomy_level",
  "is_active"           boolean NOT NULL DEFAULT true,
  "notes"               text,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"          timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "ai_workflows_org_slug_uniq" ON "ai_workflows"("organization_id", "slug");
CREATE INDEX "ai_workflows_org_active_idx" ON "ai_workflows"("organization_id", "is_active");

-- Seed the two flagship workflows for every existing org. Vapi
-- assistant ids are left null — they're populated when staff sets
-- up the assistant in VAPI's dashboard and pastes the id into
-- ai_workflows.vapi_assistant_id via the UI.

INSERT INTO "ai_workflows" (
  "organization_id", "slug", "name", "description",
  "channel", "direction", "trigger_type",
  "autonomy_level"
)
SELECT
  o.id,
  'switch_utilities',
  'Switch Utilities',
  'Outbound voice agent that calls the utility company on behalf of an owner or tenant to schedule a transfer of service. Pulls the property address, current account holder, and effective date from the lease + property record, then walks the utility rep through the change.',
  'voice',
  'outbound',
  'manual',
  -- Conservative default: AI prepares the call, staff approves
  -- before it dials the utility company.
  'approve_before_contact'
FROM "organizations" o
ON CONFLICT ("organization_id", "slug") DO NOTHING;

INSERT INTO "ai_workflows" (
  "organization_id", "slug", "name", "description",
  "channel", "direction", "trigger_type",
  "autonomy_level"
)
SELECT
  o.id,
  'payment_plan_followup',
  'Payment Plan Followup',
  'Outbound voice agent that calls a tenant on a payment plan to confirm the next installment, answer questions, and either record a payment promise or escalate to staff. Reads the tenant balance, the payment plan terms, and the last payment date from AR.',
  'voice',
  'outbound',
  'event:payment_plan_installment_due',
  -- AI runs the call freely; committing a NEW payment plan or
  -- accepting an extension is a high-risk function call that
  -- queues for approval.
  'approve_before_action'
FROM "organizations" o
ON CONFLICT ("organization_id", "slug") DO NOTHING;
