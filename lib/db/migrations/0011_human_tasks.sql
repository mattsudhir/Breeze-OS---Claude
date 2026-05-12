-- PR Tasks-1: human_tasks queue
--
-- Person-facing inbox for "things needing manual action" — payment
-- allocations to apply in AppFolio, tenant requests needing PM
-- review, vendor follow-ups. Distinct from the existing `tasks`
-- table which is the system cron worker's retry queue.
--
-- Each task type carries its own SLA in lib/humanTasks.js; due_at
-- is computed at create time, so SLA changes affect only future
-- tasks. Existing tasks keep the dueAt they were stamped with.
--
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS so re-running
-- is a no-op.

CREATE TABLE IF NOT EXISTS "human_tasks" (
  "id"                   uuid                     PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id"      uuid                     NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,

  "task_type"            text                     NOT NULL,
  "title"                text                     NOT NULL,
  "description"          text,

  "related_entity_type"  text,
  "related_entity_id"    text,

  "assignee_user_id"     text,
  "priority"             text                     NOT NULL DEFAULT 'normal',
  "status"               text                     NOT NULL DEFAULT 'open',

  "due_at"               timestamp with time zone,
  "sla_hours"            integer,

  "payload"              jsonb,
  "source"               text                     NOT NULL DEFAULT 'system',

  "created_at"           timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at"         timestamp with time zone,
  "completed_by"         text
);

CREATE INDEX IF NOT EXISTS "human_tasks_status_idx"
  ON "human_tasks" ("organization_id", "status", "due_at");

CREATE INDEX IF NOT EXISTS "human_tasks_type_idx"
  ON "human_tasks" ("task_type");

CREATE INDEX IF NOT EXISTS "human_tasks_entity_idx"
  ON "human_tasks" ("related_entity_type", "related_entity_id");

CREATE INDEX IF NOT EXISTS "human_tasks_assignee_idx"
  ON "human_tasks" ("assignee_user_id", "status");
