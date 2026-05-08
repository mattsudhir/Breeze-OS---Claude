-- PR Settings-1: issue category → GL account mapping
--
-- Persists the user's preferred GL account for each repair-fee
-- category (Plumbing, Electrical, HVAC, Other). The Charge Fee
-- modal reads this to auto-fill the GL dropdown when the user
-- picks a category, instead of forcing them to scroll a flat list
-- of every "Repairs - …" account on every charge.
--
-- One row per (org, category). Idempotent.

CREATE TABLE IF NOT EXISTS "issue_gl_mappings" (
  "id"               uuid                     PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id"  uuid                     NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,

  "category"         text                     NOT NULL,
  "gl_account_id"    text,
  "gl_account_name"  text                     NOT NULL,

  "created_at"       timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"       timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "issue_gl_mappings_unique_idx"
  ON "issue_gl_mappings" ("organization_id", "category");
