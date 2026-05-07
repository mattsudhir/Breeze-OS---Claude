-- PR Mirror-1: AppFolio mirror foundation
--
-- One row per AppFolio resource we want to serve from our own
-- Postgres instead of round-tripping through their slow read API.
-- The webhook receiver (PR B2) and reconciliation cron (TBD) keep
-- this in sync; menu-page reads come straight out of here at
-- sub-100ms instead of 1-3s per AppFolio call.
--
-- Composite PK on (organization_id, resource_type, resource_id)
-- since each AppFolio resource is naturally unique by that triple.
-- ON CONFLICT clauses in the upsert helper key off the same.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT
-- EXISTS so re-running is a no-op.

CREATE TABLE IF NOT EXISTS "appfolio_cache" (
  "organization_id"        uuid                     NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "resource_type"          text                     NOT NULL,
  "resource_id"            text                     NOT NULL,

  "property_id"            text,
  "unit_id"                text,
  "occupancy_id"           text,
  "status"                 text,
  "hidden_at"              timestamp with time zone,

  "data"                   jsonb                    NOT NULL,

  "appfolio_updated_at"    timestamp with time zone,
  "synced_at"              timestamp with time zone NOT NULL DEFAULT now(),

  PRIMARY KEY ("organization_id", "resource_type", "resource_id")
);

CREATE INDEX IF NOT EXISTS "appfolio_cache_type_idx"
  ON "appfolio_cache" ("organization_id", "resource_type");

CREATE INDEX IF NOT EXISTS "appfolio_cache_property_idx"
  ON "appfolio_cache" ("resource_type", "property_id");

CREATE INDEX IF NOT EXISTS "appfolio_cache_unit_idx"
  ON "appfolio_cache" ("resource_type", "unit_id");

CREATE INDEX IF NOT EXISTS "appfolio_cache_synced_idx"
  ON "appfolio_cache" ("resource_type", "synced_at");
