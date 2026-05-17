-- 0035: maintenance_tickets.title_source — track where the current
-- title came from so the AI-summarization cron knows what to
-- re-derive vs leave alone, the sync knows not to overwrite manual
-- edits, and the UI can badge AI-summarized titles.
--
-- See ADR 0004 for the design.
--
-- Values (text, not an enum — easier to extend later without an
-- ALTER TYPE migration):
--   'raw'              — title equals the AppFolio source field as-is
--                         (legacy rows pre-0035; sync may upgrade
--                         them to first_sentence on next run)
--   'first_sentence'   — derived via firstSentenceOf() at ingest;
--                         the safe default for new rows
--   'ai_summary'       — derived via the summarize-pending-titles
--                         endpoint (Claude)
--   'manual_edit'      — set explicitly by a user via
--                         upsert-maintenance-ticket; sync must not
--                         overwrite, AI cron must not re-summarize

ALTER TABLE "maintenance_tickets"
  ADD COLUMN "title_source" text NOT NULL DEFAULT 'first_sentence';

-- Partial index for the AI-summarization queue worker: surface
-- rows that are candidates for re-titling (first_sentence + long
-- description). Lets the worker query "give me 50 candidates"
-- without a sequential scan.
CREATE INDEX IF NOT EXISTS "maintenance_tickets_title_source_idx"
  ON "maintenance_tickets" ("title_source");
