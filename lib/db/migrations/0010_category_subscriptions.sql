-- PR B4: category subscriptions
--
-- "Alert me on every rent payment / new urgent work order / new
-- tenant" — distinct from per-entity follows. Both paths fan out
-- into the same notifications table.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS "category_subscriptions" (
  "id"               uuid                     PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id"  uuid                     NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id"          text                     NOT NULL,
  "category"         text                     NOT NULL,
  "criteria"         jsonb,
  "created_at"       timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "cat_subs_unique_idx"
  ON "category_subscriptions" ("organization_id", "user_id", "category");

CREATE INDEX IF NOT EXISTS "cat_subs_user_idx"
  ON "category_subscriptions" ("user_id");

CREATE INDEX IF NOT EXISTS "cat_subs_category_idx"
  ON "category_subscriptions" ("category");
