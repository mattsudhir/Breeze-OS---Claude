-- Setup wizard state.
--
-- Tracks per-org progress through the onboarding stepper. Each step
-- writes its completion into the jsonb blob; the wizard reads this
-- on every page load to decide whether to show the stepper, and
-- which step to land on if the user bailed out mid-flow.
--
-- Shape:
--   {
--     "current_step": "entity" | "owner" | "properties" | ...,
--     "completed_steps": ["org", "entity", "owner"],
--     "started_at": ISO timestamp,
--     "completed_at": ISO timestamp | null,
--     "skipped_steps": ["opening-balance"]
--   }
--
-- Nullable so existing orgs (no wizard run) get a graceful default
-- of "wizard already done, no need to prompt." New orgs start with
-- onboarding_state = {"current_step":"org","completed_steps":[]}.

ALTER TABLE "organizations"
  ADD COLUMN "onboarding_state" jsonb;
