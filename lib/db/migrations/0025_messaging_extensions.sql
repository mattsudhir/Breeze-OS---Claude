-- Messaging extensions for Twilio SMS + cross-channel intentionality.
--
-- Three concepts added on top of migration 0022:
--
--   1. Phone numbers we manage (our outbound + inbound surface)
--   2. Sticky from-number + staff-paused flags on threads
--   3. Per-channel consent tracking and tenant phone aliases
--   4. Voice call directives (text steering of in-flight AI calls)
--   5. Provider reconciliation audit (webhook-drift detection)
--
-- The sticky-from-number design ensures every outbound to a given
-- tenant comes from the same Twilio number, even as the org adds
-- numbers later. Inbound replies match by `to_number` → thread,
-- so reply continuity is guaranteed regardless of which number the
-- tenant texted.

-- ── Phone numbers ───────────────────────────────────────────────

CREATE TYPE "phone_number_purpose" AS ENUM (
  'org_main',          -- catch-all for the org
  'property_main',     -- a specific property's line
  'support',           -- staff inbound line
  'collections',       -- AR / dunning
  'maintenance',       -- maintenance ticketing
  'voice_only'         -- VAPI assistant dial-from line
);

CREATE TABLE "phone_numbers" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id"   uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "property_id"       uuid REFERENCES "properties"("id") ON DELETE SET NULL,
  "twilio_sid"        text,                -- Twilio's PN sid
  "e164_number"       text NOT NULL,       -- '+14155551234'
  "purpose"           "phone_number_purpose" NOT NULL DEFAULT 'org_main',
  "capabilities"      jsonb,               -- {sms: bool, mms: bool, voice: bool}
  "is_active"         boolean NOT NULL DEFAULT true,
  "notes"             text,
  "created_at"        timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"        timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "phone_numbers_org_idx"      ON "phone_numbers"("organization_id");
CREATE INDEX "phone_numbers_property_idx" ON "phone_numbers"("property_id");
CREATE UNIQUE INDEX "phone_numbers_e164_uniq" ON "phone_numbers"("e164_number");

-- ── Sticky-from + staff-paused on message threads ──────────────

ALTER TABLE "message_threads"
  ADD COLUMN "from_phone_number_id" uuid REFERENCES "phone_numbers"("id") ON DELETE SET NULL,
  ADD COLUMN "staff_paused" boolean NOT NULL DEFAULT false;

CREATE INDEX "message_threads_from_phone_idx" ON "message_threads"("from_phone_number_id");

-- ── Tenant phone aliases ────────────────────────────────────────
-- One tenant can have multiple phones (work, spouse's, dad's). When
-- inbound SMS arrives from a number we know, we match by alias.

CREATE TABLE "tenant_phone_aliases" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id"   uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "tenant_id"         uuid NOT NULL,
  "phone_e164"        text NOT NULL,
  "label"             text,    -- 'primary' | 'spouse' | 'work' etc.
  "created_at"        timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "tenant_phone_aliases_uniq"
  ON "tenant_phone_aliases"("organization_id", "phone_e164");
CREATE INDEX "tenant_phone_aliases_tenant_idx" ON "tenant_phone_aliases"("tenant_id");

-- ── Per-channel consent ────────────────────────────────────────
-- TCPA / CASL compliance. Listening for inbound STOP / UNSUBSCRIBE
-- on SMS flips status to opted_out; future outbound is hard-gated.

CREATE TYPE "communication_consent_status" AS ENUM (
  'active',
  'opted_out',
  'unknown'
);

CREATE TABLE "tenant_communication_consents" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id"     uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "tenant_id"           uuid NOT NULL,
  "channel"             "message_channel" NOT NULL,
  "status"              "communication_consent_status" NOT NULL DEFAULT 'active',
  "consented_at"        timestamp with time zone,
  "opted_out_at"        timestamp with time zone,
  "opted_out_via_msg"   uuid,   -- which inbound message contained the STOP
  "updated_at"          timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "tenant_consent_uniq" ON "tenant_communication_consents"("tenant_id", "channel");
CREATE INDEX "tenant_consent_org_idx" ON "tenant_communication_consents"("organization_id");

-- ── Voice call directives ──────────────────────────────────────
-- Staff "steering" messages injected into an active VAPI call to
-- adjust the AI's behavior mid-conversation.

CREATE TABLE "voice_call_directives" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id"  uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "voice_call_id"    uuid NOT NULL REFERENCES "voice_calls"("id") ON DELETE CASCADE,
  "staff_user_id"    uuid,
  "directive_text"   text NOT NULL,
  "delivered_at"     timestamp with time zone,
  "created_at"       timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "voice_call_directives_call_idx" ON "voice_call_directives"("voice_call_id");

-- ── Phone provider reconciliations ──────────────────────────────
-- Audit + drift detection for webhook reliability.

CREATE TABLE "phone_provider_reconciliations" (
  "id"                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id"        uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "provider"               text NOT NULL,  -- 'twilio' | 'vapi'
  "run_at"                 timestamp with time zone NOT NULL DEFAULT now(),
  "scanned_window_start"   timestamp with time zone NOT NULL,
  "scanned_window_end"     timestamp with time zone NOT NULL,
  "matched_count"          integer NOT NULL DEFAULT 0,
  "inserted_count"         integer NOT NULL DEFAULT 0,
  "anomalies"              jsonb
);

CREATE INDEX "phone_reconciliations_org_idx"      ON "phone_provider_reconciliations"("organization_id");
CREATE INDEX "phone_reconciliations_provider_idx" ON "phone_provider_reconciliations"("provider", "run_at");
