-- Maintenance tickets — the work-order layer.
--
-- A maintenance_ticket is the canonical record of "something needs
-- to get fixed at a property." Tenants report (via portal / SMS /
-- email / phone); staff triage and dispatch; vendors do the work;
-- costs land in AP via the bills table.
--
-- Status flow:
--   new           — just reported, not yet triaged
--   triage        — staff is sizing it up
--   assigned      — vendor assigned (or scheduled to in-house staff)
--   in_progress   — work happening
--   awaiting_parts / awaiting_tenant — paused for external blocker
--   completed     — done, ready to bill / close
--   cancelled     — no work done (mis-report, dup, etc.)
--
-- Costs link to bills via bill_id. When a bill posts for a ticket,
-- this row's actual_cost_cents = bill.amount_cents (eventually we'll
-- support multiple bills per ticket — for now one-to-one).
--
-- A ticket_comments timeline carries the conversation (tenant
-- updates, staff dispatch notes, vendor confirmations, AI triage).

CREATE TYPE "maintenance_ticket_status" AS ENUM (
  'new',
  'triage',
  'assigned',
  'in_progress',
  'awaiting_parts',
  'awaiting_tenant',
  'completed',
  'cancelled'
);

CREATE TYPE "maintenance_ticket_priority" AS ENUM (
  'low',
  'medium',
  'high',
  'emergency'
);

CREATE TYPE "maintenance_comment_author_type" AS ENUM (
  'staff',
  'tenant',
  'vendor',
  'ai',
  'system'
);

CREATE TABLE "maintenance_tickets" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id"     uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  -- Attribution chain
  "property_id"         uuid REFERENCES "properties"("id") ON DELETE SET NULL,
  "unit_id"             uuid REFERENCES "units"("id") ON DELETE SET NULL,
  "tenant_id"           uuid,
  -- Vendor assignment
  "vendor_id"           uuid REFERENCES "vendors"("id") ON DELETE SET NULL,
  "assigned_to_user_id" uuid,
  -- Ticket content
  "title"               text NOT NULL,
  "description"         text,
  "category"            text,            -- 'plumbing' | 'electrical' | 'hvac' | 'appliance' | 'other' (free-form for v1)
  "priority"            "maintenance_ticket_priority" NOT NULL DEFAULT 'medium',
  "status"              "maintenance_ticket_status"   NOT NULL DEFAULT 'new',
  -- Timestamps
  "reported_at"         timestamp with time zone NOT NULL DEFAULT now(),
  "scheduled_at"        timestamp with time zone,
  "completed_at"        timestamp with time zone,
  -- Cost tracking
  "estimated_cost_cents" bigint,
  "actual_cost_cents"    bigint,
  "bill_id"              uuid,            -- link once an AP bill is created
  -- Source breadcrumb
  "source_ticket_id"    text,
  "source_pms"          text NOT NULL DEFAULT 'breeze',
  "notes"               text,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"          timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "maintenance_tickets_org_idx"          ON "maintenance_tickets"("organization_id");
CREATE INDEX "maintenance_tickets_property_idx"     ON "maintenance_tickets"("property_id");
CREATE INDEX "maintenance_tickets_unit_idx"         ON "maintenance_tickets"("unit_id");
CREATE INDEX "maintenance_tickets_tenant_idx"       ON "maintenance_tickets"("tenant_id");
CREATE INDEX "maintenance_tickets_vendor_idx"       ON "maintenance_tickets"("vendor_id");
CREATE INDEX "maintenance_tickets_status_idx"       ON "maintenance_tickets"("organization_id", "status");
CREATE INDEX "maintenance_tickets_priority_idx"     ON "maintenance_tickets"("organization_id", "priority");
CREATE INDEX "maintenance_tickets_source_idx"       ON "maintenance_tickets"("source_ticket_id");

CREATE TABLE "maintenance_ticket_comments" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id"     uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "ticket_id"           uuid NOT NULL REFERENCES "maintenance_tickets"("id") ON DELETE CASCADE,
  "author_type"         "maintenance_comment_author_type" NOT NULL,
  "author_id"           uuid,
  "author_display"      text,            -- snapshot of author name for audit
  "body"                text NOT NULL,
  "is_internal"         boolean NOT NULL DEFAULT false,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "maintenance_ticket_comments_ticket_idx" ON "maintenance_ticket_comments"("ticket_id");
CREATE INDEX "maintenance_ticket_comments_org_idx"    ON "maintenance_ticket_comments"("organization_id");
