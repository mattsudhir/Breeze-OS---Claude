-- admin_error_log: every /api/admin/* error captured automatically by
-- withAdminHandler. Lets ops (and Claude, via GitHub Actions) read the
-- last N failures with their stack traces instead of digging through
-- Vercel function logs or relying on screenshot loops.
--
-- Intentionally org-less: errors can happen before getDefaultOrgId()
-- resolves, and we want to capture those too.
--
-- A trim policy (keep last 5,000 rows) runs on each insert via a small
-- trigger so the table never grows unbounded.

CREATE TABLE IF NOT EXISTS "admin_error_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "path" text NOT NULL,
  "method" text NOT NULL,
  "status" integer,
  "message" text NOT NULL,
  "stack" text,
  "context" jsonb
);

CREATE INDEX IF NOT EXISTS "admin_error_log_created_idx"
  ON "admin_error_log" ("created_at" DESC);

-- Trim trigger — keep the last 5000 rows. Cheap and self-healing.
CREATE OR REPLACE FUNCTION "admin_error_log_trim"() RETURNS trigger AS $$
BEGIN
  DELETE FROM "admin_error_log"
  WHERE "id" IN (
    SELECT "id" FROM "admin_error_log"
    ORDER BY "created_at" DESC
    OFFSET 5000
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "admin_error_log_trim_trg" ON "admin_error_log";
CREATE TRIGGER "admin_error_log_trim_trg"
  AFTER INSERT ON "admin_error_log"
  FOR EACH STATEMENT
  EXECUTE FUNCTION "admin_error_log_trim"();
