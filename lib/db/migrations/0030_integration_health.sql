-- Integration health — proactive monitoring for every external system.
--
-- One row per (organization, integration name). The probe cron + sync
-- endpoints write to it; the topbar reads from it to flash a red dot
-- when something's failing.
--
-- Status semantics:
--   ok        — last probe / call succeeded
--   degraded  — at least one recent failure but at least one recent success
--   down      — every recent attempt has failed (most recent ≥1 failure,
--               no success in the last 24h)
--   unknown   — never probed (initial state)
--
-- consecutive_failures lets the cron decide when to escalate from
-- degraded → down (e.g. 3+ in a row = down).

CREATE TYPE "integration_health_status" AS ENUM (
  'ok',
  'degraded',
  'down',
  'unknown'
);

CREATE TABLE "integration_health" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id"       uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name"                  text NOT NULL,                      -- e.g. 'appfolio_database', 'bill_com', 'plaid'
  "display_name"          text NOT NULL,                      -- pretty label for UI
  "status"                "integration_health_status" NOT NULL DEFAULT 'unknown',
  "last_success_at"       timestamp with time zone,
  "last_failure_at"       timestamp with time zone,
  "last_error_message"    text,
  "last_probe_at"         timestamp with time zone,
  "consecutive_failures"  integer NOT NULL DEFAULT 0,
  "consecutive_successes" integer NOT NULL DEFAULT 0,
  "created_at"            timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"            timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "integration_health_org_name_uniq"
  ON "integration_health"("organization_id", "name");
CREATE INDEX "integration_health_status_idx"
  ON "integration_health"("organization_id", "status");
