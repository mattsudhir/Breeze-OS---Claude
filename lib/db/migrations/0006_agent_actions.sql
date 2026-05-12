-- PR A: agent_actions audit log
--
-- One row per AI tool invocation (search_tenants, charge_tenant,
-- make_call, notify_team, etc.). Captured by lib/agentAudit.js
-- around every executeTool() call in lib/breezeAgent.js.
--
-- Distinct from the existing audit_events table, which tracks state
-- changes on our own tables. This is the agent's own action log —
-- useful for "what did the AI do today?", "who charged Frank Strehl
-- on April 15?", and incident response when a tool misbehaves.
--
-- Idempotent: uses CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT
-- EXISTS so re-running the migration is a no-op.

CREATE TABLE IF NOT EXISTS "agent_actions" (
  "id"                     uuid                     PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id"        uuid                     NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),

  "surface"                text                     NOT NULL,
  "user_id"                text,
  "conversation_id"        text,
  "backend_name"           text,

  "tool_name"              text                     NOT NULL,
  "tool_input"             jsonb                    NOT NULL,
  "tool_output"            jsonb,

  "success"                boolean                  NOT NULL,
  "error_text"             text,
  "duration_ms"            integer                  NOT NULL,

  "appfolio_tenant_id"     text,
  "appfolio_occupancy_id"  text,
  "appfolio_property_id"   text,
  "appfolio_unit_id"       text,
  "appfolio_charge_id"     text,
  "appfolio_work_order_id" text
);

CREATE INDEX IF NOT EXISTS "agent_actions_org_time_idx"
  ON "agent_actions" ("organization_id", "created_at");

CREATE INDEX IF NOT EXISTS "agent_actions_tool_time_idx"
  ON "agent_actions" ("tool_name", "created_at");

CREATE INDEX IF NOT EXISTS "agent_actions_tenant_idx"
  ON "agent_actions" ("appfolio_tenant_id");

CREATE INDEX IF NOT EXISTS "agent_actions_charge_idx"
  ON "agent_actions" ("appfolio_charge_id");

CREATE INDEX IF NOT EXISTS "agent_actions_work_order_idx"
  ON "agent_actions" ("appfolio_work_order_id");
