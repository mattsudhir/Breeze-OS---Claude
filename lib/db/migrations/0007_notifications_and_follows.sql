-- PR B1: notifications + follows
--
-- Foundation for the alert system. follows records what each user
-- has subscribed to; notifications is the user-facing event log.
-- The webhook receiver and bell UI come in subsequent PRs and only
-- read/write through these two tables.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT
-- EXISTS so re-running is a no-op.

-- ── follows ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "follows" (
  "id"               uuid                     PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id"  uuid                     NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id"          text                     NOT NULL,
  "entity_type"      text                     NOT NULL,
  "entity_id"        text                     NOT NULL,
  "entity_label"     text,
  "created_at"       timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "follows_unique_idx"
  ON "follows" ("organization_id", "user_id", "entity_type", "entity_id");

CREATE INDEX IF NOT EXISTS "follows_user_idx"
  ON "follows" ("user_id");

CREATE INDEX IF NOT EXISTS "follows_entity_idx"
  ON "follows" ("entity_type", "entity_id");

-- ── notifications ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "notifications" (
  "id"                uuid                     PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id"   uuid                     NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id"           text                     NOT NULL,

  "entity_type"       text,
  "entity_id"         text,
  "entity_label"      text,

  "event_type"        text,
  "source"            text                     NOT NULL,

  "title"             text                     NOT NULL,
  "body"              text,
  "link_url"          text,

  "payload"           jsonb,
  "source_event_id"   text,

  "read_at"           timestamp with time zone,
  "created_at"        timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "notifications_user_time_idx"
  ON "notifications" ("user_id", "created_at");

CREATE INDEX IF NOT EXISTS "notifications_user_unread_idx"
  ON "notifications" ("user_id", "read_at");

-- Dedup webhook deliveries. Postgres treats NULLs as distinct in
-- unique indexes, so non-webhook notifications (source_event_id
-- null) aren't constrained — they can't collide because they have
-- no event id to dedup against.
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_source_event_idx"
  ON "notifications" ("user_id", "source_event_id");
