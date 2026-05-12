-- PR C: web push subscriptions
--
-- One row per browser-installed push subscription. fanoutEvent
-- looks up every row keyed on (organization_id, user_id) and
-- POSTs to each endpoint via web-push when a notification is
-- created. Stale subscriptions get auto-pruned on 404 / 410 from
-- the push service.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT
-- EXISTS so re-running is a no-op.

CREATE TABLE IF NOT EXISTS "push_subscriptions" (
  "id"               uuid                     PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id"  uuid                     NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id"          text                     NOT NULL,
  "endpoint"         text                     NOT NULL,
  "p256dh"           text                     NOT NULL,
  "auth"             text                     NOT NULL,
  "user_agent"       text,
  "created_at"       timestamp with time zone NOT NULL DEFAULT now(),
  "last_seen_at"     timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "push_subs_endpoint_idx"
  ON "push_subscriptions" ("endpoint");

CREATE INDEX IF NOT EXISTS "push_subs_user_idx"
  ON "push_subscriptions" ("user_id");
