-- Stage 3 follow-up: per-org configurable thresholds for the
-- reconciliation auto-match worker.
--
-- Until now `runRulesAgainstTransaction` hard-coded the auto-match
-- gate at confidence >= 0.95 AND times_used > 5. Conservative for
-- a fresh org with no prior rules history; too conservative once
-- staff have curated a few hundred rules. Expose both knobs as
-- per-org settings so each org can dial its own risk tolerance:
--
--   recon_auto_match_confidence
--     Minimum confidence_score for a candidate to qualify as
--     auto_matched (vs pending_review). Below this → human review.
--     Default 0.95 preserves current behavior.
--
--   recon_auto_match_min_times_used
--     Minimum times_used on the rule before any of its candidates
--     can be auto_matched. Defaults to 5 — a rule needs to have
--     earned trust through 5+ confirmations before its candidates
--     bypass review.
--
-- Both NOT NULL with defaults so existing orgs require no backfill.

ALTER TABLE "organizations"
  ADD COLUMN "recon_auto_match_confidence" real NOT NULL DEFAULT 0.95,
  ADD COLUMN "recon_auto_match_min_times_used" integer NOT NULL DEFAULT 5;

-- Sanity-check ranges. Confidence is a probability; times_used a
-- non-negative count. Allow 0 for "auto-match anything that meets
-- confidence" if an org wants to live dangerously.
ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_recon_confidence_range"
    CHECK ("recon_auto_match_confidence" >= 0 AND "recon_auto_match_confidence" <= 1);
ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_recon_min_times_used_nonneg"
    CHECK ("recon_auto_match_min_times_used" >= 0);
