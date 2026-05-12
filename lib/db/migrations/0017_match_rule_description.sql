-- Stage 3 follow-up: LLM-assisted reconciliation support columns on
-- match_rules.
--
-- Two columns added so the rule-generator service has somewhere to
-- store user-facing context and the auto-match worker can reason
-- about rule freshness:
--
--   natural_language_description
--     The user's original one-liner that produced the rule. Surfaced
--     in the rules list UI ("All Walmart for SLM properties during
--     turnover") so staff can read what each rule does without
--     having to interpret pattern_payload jsonb.
--
--   last_matched_at
--     When the auto-match worker most recently produced a candidate
--     from this rule. Used to age out stale rules in the management
--     UI (rules unused for 6+ months get a "consider archiving"
--     hint).

ALTER TABLE "match_rules"
  ADD COLUMN "natural_language_description" text,
  ADD COLUMN "last_matched_at" timestamp with time zone;
