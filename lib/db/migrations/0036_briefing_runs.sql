-- 0036: briefing_runs — bookkeeping for the daily-briefing
-- pull-on-demand feature. Each row records that someone asked
-- for a briefing, what window it covered, and the structured
-- signals snapshot we handed Claude. The narrative summary
-- itself lives in the chat conversation log, not here.
--
-- The primary read pattern is "what's the most recent briefing
-- for this actor?" — used to compute the next briefing's window
-- (from prev.window_end → now). Hence the (actor_type, actor_id,
-- created_at) index.
--
-- See ADR 0005 for the design.

CREATE TABLE IF NOT EXISTS "briefing_runs" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at"       timestamp with time zone NOT NULL DEFAULT now(),
  "organization_id"  uuid REFERENCES "organizations"("id") ON DELETE CASCADE,
  -- Who got briefed. Mirrors admin_audit_log's actor model.
  "actor_type"       text NOT NULL,   -- 'clerk_user' | 'admin_token' | 'unknown'
  "actor_id"         text,            -- Clerk userId or null
  -- Optional scope filter — null = whole org.
  "entity_id"        uuid REFERENCES "entities"("id") ON DELETE SET NULL,
  -- Time window the briefing covered.
  "window_start"     timestamp with time zone NOT NULL,
  "window_end"       timestamp with time zone NOT NULL,
  -- Structured snapshot of the signals fed to Claude. Schema
  -- evolves with the briefing template; treat as opaque JSON.
  "signals"          jsonb NOT NULL,
  -- Bookkeeping: model used for the narrative + token counts when
  -- available. Optional for v1; useful for cost tracking later.
  "model"            text,
  "input_tokens"     integer,
  "output_tokens"    integer
);

CREATE INDEX IF NOT EXISTS "briefing_runs_actor_idx"
  ON "briefing_runs" ("actor_type", "actor_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "briefing_runs_org_idx"
  ON "briefing_runs" ("organization_id", "created_at" DESC);

-- Trim trigger — keep the last 10,000 rows per actor's worth of
-- history. Cheap and self-pruning.
CREATE OR REPLACE FUNCTION "briefing_runs_trim"() RETURNS trigger AS $$
BEGIN
  DELETE FROM "briefing_runs"
  WHERE "id" IN (
    SELECT "id" FROM "briefing_runs"
    ORDER BY "created_at" DESC
    OFFSET 10000
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "briefing_runs_trim_trg" ON "briefing_runs";
CREATE TRIGGER "briefing_runs_trim_trg"
  AFTER INSERT ON "briefing_runs"
  FOR EACH STATEMENT
  EXECUTE FUNCTION "briefing_runs_trim"();
