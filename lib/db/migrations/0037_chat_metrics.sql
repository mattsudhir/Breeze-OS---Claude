-- 0037: chat_metrics — pre-computed answers to common chat
-- questions ("how many X", "what's tenant Y's balance", etc.).
--
-- One row per (organization_id, metric_key, scope_type, scope_id).
-- scope_type='org' + scope_id='' for org-wide aggregates; scope_type
-- ∈ {'tenant','property','unit','entity'} for scoped metrics.
--
-- value is jsonb because the shape depends on the metric — a count
-- might be {"total":2215,"active":2128}; a balance might be 12345.
--
-- Lifecycle:
--   1. AppFolio webhook lands → invalidator marks dependent metrics
--      dirty (stale=true, dirty_at=now()).
--   2. Cron sweep (every 5 min) recomputes everything dirty.
--   3. Hourly sweep recomputes the full set unconditionally as a
--      safety net against missed webhooks.
--   4. Read path (chat tool): if value is missing OR computed_at is
--      older than the per-metric TTL, compute live + return + enqueue
--      dirty so the cron picks it up.
--
-- See ADR 0006.

CREATE TABLE IF NOT EXISTS "chat_metrics" (
  "organization_id"  uuid NOT NULL
    REFERENCES "organizations"("id") ON DELETE CASCADE,
  "metric_key"       text NOT NULL,
  "scope_type"       text NOT NULL DEFAULT 'org',
  "scope_id"         text NOT NULL DEFAULT '',
  "value"            jsonb NOT NULL,
  "computed_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "stale"            boolean NOT NULL DEFAULT false,
  "dirty_at"         timestamp with time zone,
  "compute_ms"       integer,
  PRIMARY KEY ("organization_id", "metric_key", "scope_type", "scope_id")
);

-- "Show me what's dirty" — drives the cron sweep.
CREATE INDEX IF NOT EXISTS "chat_metrics_dirty_idx"
  ON "chat_metrics" ("stale", "dirty_at")
  WHERE "stale" = true;

-- "Show me everything for this metric_key" — drives bulk invalidation
-- (e.g. "mark every per-tenant balance dirty after a charges webhook").
CREATE INDEX IF NOT EXISTS "chat_metrics_key_idx"
  ON "chat_metrics" ("organization_id", "metric_key");

-- "How old is this set of metrics?" — debug / admin view.
CREATE INDEX IF NOT EXISTS "chat_metrics_computed_at_idx"
  ON "chat_metrics" ("organization_id", "computed_at" DESC);
