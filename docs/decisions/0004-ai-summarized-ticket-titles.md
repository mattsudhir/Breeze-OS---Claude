# 0004. AI-summarized maintenance ticket titles

**Status:** Proposed (not yet implemented — awaiting decision)
**Date:** 2026-05-17
**Deciders:** mattsudhir + Claude (this session)

## Context

Today (after commit `a495b96`), maintenance ticket titles are
derived during the AppFolio sync via `firstSentenceOf()` — we
take the first sentence / line / colon-led clause from the work
order's `JobDescription`, cap at 120 chars, and store that as
`maintenance_tickets.title`. Full text lives in `description`.

This works for most tickets ("Kitchen sink leaking", "Annual
HVAC service"). It works badly for inspection-style narratives:

- **Input:** `SLM Toledo Investments LLC, as surveyed by Millers
  Mutual on April 17, 2026. — You must notify your insurance agent
  of compliance status for these recommendations within 30 days.
  01-2026-01: There was an inadequate amount of smoke detectors.
  U.L. smoke detectors should be installed in every living unit
  in the building. Ideally, these detectors should be continuously
  powered by the building's electrical system...`
- **Current title:** `SLM Toledo Investments LLC, as surveyed by
  Millers Mutual on April 17, 2026` (the first sentence).
- **What the user actually needs to see:** `Insurance inspection:
  install smoke detectors in all units`.

The first-sentence heuristic gives boilerplate ("as surveyed by
X on date Y") priority over substance. Inspection reports follow
a stereotyped opening pattern that defeats it.

Proposal: use an LLM to summarize the description to 10–12 words
and store that as the title.

## Decision

**Proposed, pending sign-off.** Treat this as a deferred change
— current code keeps the first-sentence heuristic; this ADR
captures the tradeoff so we can choose deliberately.

If we adopt: implementation shape below. If we don't: keep
first-sentence and accept the inspection-style ugliness as a
known limitation, OR layer a small rule-based ignore-list ("if
the description starts with 'X Insurance' or 'as surveyed by',
skip the first sentence and try the second").

## What "AI-summarized" would look like

### Schema changes
```sql
ALTER TABLE maintenance_tickets
  ADD COLUMN title_source text NOT NULL DEFAULT 'first_sentence';
  -- one of: 'raw' | 'first_sentence' | 'ai_summary' | 'manual_edit'
```

`title_source` documents WHERE the current title came from. It
guides the sync (don't overwrite manual edits), the cron
(re-summarize when first_sentence titles are too long), and the
UI (a tiny "AI" badge next to AI-summarized titles).

### Ingest path (unchanged)
`sync-appfolio-tickets.js` continues to derive `title` via
`firstSentenceOf()` and sets `title_source = 'first_sentence'`.
Fast, deterministic, runs in-line with the sync.

### Background path (new)
A new endpoint `/api/admin/summarize-pending-titles` (or a cron):

1. Pull every ticket with `title_source = 'first_sentence'` AND
   `length(description) > 200` (or some heuristic for "this title
   would benefit from a summary").
2. Batch through them — 10–20 at a time.
3. For each: call Claude Haiku (or similar small/cheap model) with
   a prompt like:
   ```
   You are summarizing a property maintenance ticket. Output a
   single-line title, 10–12 words, in active voice. Focus on what
   needs to be done, not who reported it or compliance boilerplate.
   No quotes, no period at the end. Examples:

   In:  "Tenant reports kitchen sink leaking at base, water pooling
         under cabinet."
   Out: Kitchen sink leak at base — water pooling under cabinet

   In:  "SLM Toledo Investments LLC, as surveyed by Millers Mutual
         ... inadequate smoke detectors..."
   Out: Insurance inspection: install hard-wired smoke detectors in all units

   Now summarize:
   <description>
   ```
4. Update the ticket: `title = <ai output>`, `title_source = 'ai_summary'`.
5. On manual edit in the UI → `title_source = 'manual_edit'`,
   cron skips on subsequent runs.
6. On AppFolio re-sync, if `title_source != 'manual_edit'` AND
   the source description changed materially → reset to
   `first_sentence` and re-queue for AI summarization.

### Cost estimate
- 9836 existing tickets × ~$0.0001/inference with Claude Haiku =
  **~$1.00 to backfill once.**
- Ongoing: maybe ~50 new tickets/day → **~$0.005/day**.
- Cost is negligible. Time is the real budget.

### Latency
Background, not in-line with sync. The user sees `first_sentence`
titles immediately on sync; AI titles backfill within minutes.

## Tradeoffs

### Pros
- Inspection narratives, eviction filings, and other stereotyped
  formats get useful titles instead of boilerplate.
- Consistent length and tone across the list view (no more
  120-char titles wrapping to two clamped lines while next to a
  3-word one).
- Sets up a reusable pattern for other "long-text → short-label"
  needs (vendor invoice summaries, message-thread titles, AI
  workflow run summaries).

### Cons
- **External dependency.** Title quality depends on the LLM
  provider being up and on-prompt. A regression at the provider
  end could produce systematically bad titles.
- **Determinism.** Two runs of the same input can produce
  different titles. Mitigated by storing the title once and only
  re-deriving when the source changes, but two operators running
  the backfill on different days might get different titles for
  the same ticket. Probably fine, possibly confusing.
- **PII surface.** We send the maintenance description to a
  third-party LLM. Descriptions can contain tenant names, unit
  addresses, vendor info — same data we already send to AppFolio
  and our other backends, so the marginal exposure is small. But
  document it (privacy policy already mentions AI providers; this
  is in scope).
- **Drift.** If AppFolio updates the description, the AI title
  might no longer reflect the current ticket. Detection: hash
  the description; if it changes and title_source != 'manual_edit',
  re-queue.
- **Auditability.** A user opens a ticket, sees title "X", checks
  the description, and X isn't a verbatim quote. That's a feature
  (the whole point), but UI needs to surface "AI-summarized — full
  text below" so the user trusts what they see.

## Recommendation

**Build it as an opt-in feature**, not a default-on. Specifically:

1. Ship the schema change (`title_source` column) and the
   `summarize-pending-titles` endpoint, but don't wire a cron.
2. Surface a "Summarize titles" button on the Property Directory
   admin tab that fires the endpoint manually. User can run it
   when they want; observe results; decide if quality is good
   enough.
3. If quality is consistently good after a few weeks of manual
   runs, wire the cron at low frequency (e.g., hourly on a
   small batch).
4. If quality is patchy, leave it manual or kill it.

This avoids committing to AI titles in production before we've
seen them on real tickets. The schema is forward-compatible
either way.

## Alternatives considered

### A. Keep first-sentence (status quo)
Pros: free, instant, deterministic, no external deps.
Cons: ugly for stereotyped narratives.
Net: fine for v1; revisit if inspection tickets are a sustained
pain point.

### B. Rule-based skip list
Detect known boilerplate patterns ("as surveyed by", "X
Insurance", "Annual inspection of") and skip past them to the
next sentence.
Pros: cheap, deterministic, no AI dependency.
Cons: brittle — every new AppFolio integration partner adds new
patterns. Maintenance overhead.
Could be a stepping stone — implement (B) now, layer (C) later
when warranted.

### C. AI summary (this ADR)
Best output quality; modest cost; introduces external dep.

### D. Let the user always set the title
Make the sync's title best-effort and ship a UI affordance to
edit. The audit log already exists to track who edited what.
Pros: respects human judgment; no AI/heuristic gambles.
Cons: ~10K existing tickets are not going to get hand-titled.
Could combine with (A) or (C): sync derives a default, user
edits anything that's wrong, audit log captures it.

## Revisit when

- We finish the first-sentence backfill (`Sync from AppFolio`
  with the new ingest logic) and look at the result. If 90%+
  of titles are good, AI isn't worth the trouble. If <50% are,
  this becomes a priority.
- Other surfaces hit the same "long-text → short-label" need
  (message-thread summaries, AI workflow run titles) — at which
  point we'd want a shared `lib/ai/summarize.js` helper rather
  than ad-hoc per-table.
