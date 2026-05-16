-- admin_audit_log: append-only audit trail for every WRITE through
-- an /api/admin/* endpoint. Pairs with the existing admin_error_log
-- (which captures FAILURES); audit_log captures intentional state
-- changes regardless of success/failure.
--
-- Populated explicitly by endpoint handlers (not transparently in
-- withAdminHandler) so the snapshots are meaningful — the helper
-- recordAudit(req, { action, table, id, before, after }) writes a
-- row. See lib/adminHelpers.js.
--
-- Org-less so we can record actions taken before getDefaultOrgId()
-- resolves (e.g. initial seed).

CREATE TABLE IF NOT EXISTS "admin_audit_log" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at"   timestamp with time zone NOT NULL DEFAULT now(),

  -- Who performed the action.
  "actor_type"   text NOT NULL,       -- 'clerk_user' | 'admin_token' | 'cron' | 'unknown'
  "actor_id"     text,                -- Clerk user id, or null

  -- What endpoint was hit.
  "path"         text NOT NULL,
  "method"       text NOT NULL,

  -- What state changed.
  "action"       text NOT NULL,       -- 'CREATE' | 'UPDATE' | 'DELETE' | 'CUSTOM:<name>'
  "target_table" text,                -- e.g. 'tenants', 'leases'
  "target_id"    text,                -- text not uuid: some PKs are composite or non-uuid

  -- Snapshots. Either or both may be null depending on action.
  "before"       jsonb,               -- pre-change row state (null on CREATE)
  "after"        jsonb,               -- post-change row state (null on DELETE)
  "diff"         jsonb,               -- pre-computed delta (caller's choice)

  -- Request context (best-effort).
  "ip_address"   text,
  "user_agent"   text,
  "context"      jsonb                -- arbitrary additional structured info
);

CREATE INDEX IF NOT EXISTS "admin_audit_log_created_idx"
  ON "admin_audit_log" ("created_at" DESC);
CREATE INDEX IF NOT EXISTS "admin_audit_log_table_id_idx"
  ON "admin_audit_log" ("target_table", "target_id");
CREATE INDEX IF NOT EXISTS "admin_audit_log_actor_idx"
  ON "admin_audit_log" ("actor_type", "actor_id");

-- Trim trigger — keep the last 200,000 rows. Audit retention should
-- be longer than error retention; bump if compliance demands it.
CREATE OR REPLACE FUNCTION "admin_audit_log_trim"() RETURNS trigger AS $$
BEGIN
  DELETE FROM "admin_audit_log"
  WHERE "id" IN (
    SELECT "id" FROM "admin_audit_log"
    ORDER BY "created_at" DESC
    OFFSET 200000
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "admin_audit_log_trim_trg" ON "admin_audit_log";
CREATE TRIGGER "admin_audit_log_trim_trg"
  AFTER INSERT ON "admin_audit_log"
  FOR EACH STATEMENT
  EXECUTE FUNCTION "admin_audit_log_trim"();
