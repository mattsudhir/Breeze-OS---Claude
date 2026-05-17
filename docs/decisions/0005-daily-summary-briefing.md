# 0005. Daily summary briefing for owners and PMs

**Status:** Proposed (not yet implemented)
**Date:** 2026-05-17
**Deciders:** mattsudhir + Claude (this session)

## Context

Today an owner or property manager opens Breeze and has to look at
half a dozen surfaces — Dashboard KPIs, Maintenance queue, AI
Approval Queue, Leasing renewals, Reports — to figure out what
they need to act on. Each surface answers a different slice of
"what's going on?", and the user has to do the integration.

A daily summary delivered via chat would invert that: a single
short briefing that says "here's what changed since yesterday and
what needs your attention today." Saves five clicks; surfaces
deltas the user might otherwise miss; and uses the chat layer we
already invested in (with its full read-side tool access to our
DB) as the natural surface.

This ADR proposes the shape; implementation is deferred until
we agree on the design.

## What the briefing covers

Candidate signals, all derivable from our DB or our integrations:

| Signal                                | Source                       | When it matters |
|---------------------------------------|------------------------------|----------------|
| New maintenance tickets in last 24h   | `maintenance_tickets`         | always — emergencies/high go to top |
| Open WOs stuck > N days without status change | `maintenance_tickets` + activity log | for triage |
| Tickets reassigned or completed yesterday | `maintenance_ticket_comments` + status history | accountability |
| Leases expiring in next 30 / 60 / 90 days | `leases`                  | renewal queue |
| Tenants past due > $X or > N days     | `posted_charges` + `bank_transactions` | collections priority |
| Payments received yesterday           | `bank_transactions` (Plaid)   | reconciliation queue |
| New vacancies (units that flipped status) | derived from lease activity | leasing pipeline |
| Move-ins / move-outs completed yesterday | `move_events`              | celebrate / action |
| AI agent escalations needing approval | `agent_actions`              | approval queue size + most-urgent |
| Bills awaiting approval               | `bills`                      | AP queue |
| Bank transactions needing categorisation | `match_candidates`        | recon queue size |
| Integration health degradations       | `integration_health`         | red flags |
| Anomalies — unusual ticket spike, unusual non-payment | derived  | nice-to-have, v2+ |

Not every signal applies to every user every day. The data
collection layer should be filterable by owner/entity scope (a
single LLC's portfolio) and by signal subscription.

## Proposed shape

### Layer 1: Data collection — `/api/admin/daily-briefing-data`

A read-only endpoint that returns a structured snapshot of the
last-24h state for a given org (and optional `entity_id` to scope
to one LLC). Returns the raw counts + most-actionable items per
signal:

```json
{
  "ok": true,
  "as_of": "2026-05-18T07:00:00Z",
  "window_hours": 24,
  "scope": { "organization_id": "...", "entity_id": null },
  "signals": {
    "new_tickets": {
      "count_24h": 7,
      "by_priority": { "emergency": 1, "high": 2, "medium": 4, "low": 0 },
      "examples": [ { "id": "...", "title": "...", "property": "...", "priority": "emergency" }, ... up to 5 ]
    },
    "stale_tickets": {
      "count": 3,
      "examples": [ { "id": "...", "title": "...", "days_open": 12 } ]
    },
    "expiring_leases": {
      "in_30d": 4, "in_60d": 12, "in_90d": 25,
      "examples": [ { "tenant": "...", "unit": "...", "ends": "..." } ]
    },
    "past_due": {
      "count": 8,
      "total_cents": 1245000,
      "examples": [ { "tenant": "...", "balance_cents": 350000, "days_past_due": 14 } ]
    },
    ...
  }
}
```

Deterministic, paginate-able, cacheable. No LLM in this layer —
just SQL aggregations. Powers both the chat-driven flow and any
future cron/email/push delivery without re-running the queries.

### Layer 2: Summarization — chat tool + LLM prompt

A new agent tool `daily_briefing` registered in
`lib/breezeAgent.js`'s COMMON_TOOLS (or backend-tools, TBD).
When the user types "what should I know today?" or hits a
"Daily Briefing" quick-action button:

1. Agent calls `daily_briefing` tool with optional `{ entity_id }`.
2. Tool internally calls `/api/admin/daily-briefing-data`.
3. Returns the structured snapshot to the agent.
4. Agent's system prompt instructs it to write a tight
   single-screen briefing: lead with anything emergency-priority,
   then group by signal, then close with one "recommended next
   action."

Example output target:

```
Morning. Here's where things stand as of 7:00 AM:

🚨 1 emergency ticket: SLM Toledo — gas leak reported at Unit
   3B by tenant just now. Vendor not yet assigned.

⚠️ 2 high-priority tickets opened yesterday — both at Birchwood
   Commons. Plumbing + HVAC.

📋 3 work orders haven't moved in 10+ days. Worth a nudge to
   the assigned vendors. Tap to see them.

🏠 Lease renewals coming due:
   - 4 in next 30 days
   - 12 in next 60 days
   See Leasing tab for the renewal queue.

💰 $12,450 past due across 8 tenants. 3 are over 30 days late
   and warrant a payment-plan call. Want me to queue the AI
   caller for those?

✅ 2 ticket completions logged yesterday. 1 lease signed.

What do you want to tackle first?
```

The closing question is intentional — the briefing isn't just
informational, it primes the user to ask follow-ups in the same
chat thread.

### Layer 3: Delivery (phased)

- **v1 — pull-on-demand**: chat tool only. User opens chat,
  types or clicks "Daily Briefing". Zero new infrastructure
  outside the tool + data endpoint.
- **v2 — proactive in-app**: on first login of each day, chat
  auto-opens with the briefing pre-rendered. Per-user toggle
  to disable.
- **v3 — cross-channel**: 7am local cron emails / Cliq-DMs the
  briefing to subscribed owners. Deep-link to the chat for
  follow-ups. Per-owner subscription preferences (email vs
  Cliq vs both, time of day, signal filters).
- **v4 — anomaly detection**: include "unusual" signals
  (week-over-week spike, payment failure burst, etc.) once we
  have a baseline. Out of scope for v1–v3.

## Tradeoffs

### Pros
- Single answer to "what do I need to do today?" — replaces
  six clicks with one.
- Catches things the user might otherwise miss (a ticket that
  hasn't moved, a lease expiring quietly).
- Natural follow-up flow: user reads the briefing, asks "tell
  me more about that gas leak", agent already has chat context.
- Reuses the chat infrastructure + tool framework we already
  built; no new UI primitives.
- Compounds as the data grows — same prompt, better signal,
  with more tenants / properties / transactions over time.

### Cons
- **Prompt design risk.** A briefing that buries the lede or
  surfaces noise is worse than no briefing at all. Will need
  iteration on the system prompt + signal weighting.
- **Cost.** Per briefing: one Claude Sonnet call (more
  reasoning needed than Haiku for prioritization) + maybe one
  tool round-trip. ~$0.01–$0.03 per briefing. If we ship the
  v3 cron at one-per-owner-per-day across a 100-owner portfolio
  → ~$30–$90/month. Tolerable but worth bounding.
- **Hallucination risk.** Agent might invent details if the
  tool result is ambiguous. Mitigation: structured tool output
  + a strict "only summarise what's in the tool result, do not
  add anything" instruction in the system prompt + occasional
  spot-checks via the audit log.
- **Stale data.** Briefing reflects DB state at request time.
  If AppFolio updated a tenant 5 minutes after our last sync
  and the briefing says "tenant X is past due" but they paid
  4 minutes ago, that's wrong. Mitigation: pre-briefing sync
  hook on the cron path (run sync, then briefing).
- **Per-user scoping.** Owners want their LLC only; PMs want
  the org view. v1 should accept an optional `entity_id`
  filter; v3 needs proper per-user subscription preferences
  table.

## Open questions

1. **What's the right cadence?** Daily, weekly, or both? Daily is
   the natural fit for property managers; owners might prefer
   weekly. The cron should be configurable.
2. **What time of day?** "7am local" is a fine default but
   non-trivial — we need owner timezone (currently not in our
   schema). Default to Eastern Time for now; add a user pref
   table later.
3. **In-app placement.** Auto-open chat on first login feels
   pushy. Maybe a "📋 Daily Briefing" pill at the top of the
   Dashboard that pulls on click? Or a notification bell that
   says "Today's briefing is ready"?
4. **Owner vs PM scoping in chat.** When a PM opens chat, do
   they get one briefing covering all owners or a switcher? My
   instinct: switcher in the topbar (we already have one for
   data source); chat respects current selection.
5. **Action callouts.** The example briefing ends with "Want me
   to queue the AI caller?" — that's an actionable suggestion.
   Should the agent be allowed to do that in-line, or always
   defer to a manual click? I'd start with "always require
   explicit user confirmation in the chat" to avoid surprises.

## Recommendation

Build v1 (data endpoint + chat tool) as the smallest end-to-end
slice. ~1 working day of effort. Use it for a week or two; see
what signals are actually useful and what's noise; then decide
whether to invest in v2/v3.

Concrete v1 deliverables:
- `api/admin/daily-briefing-data` — read-only data collector
- `daily_briefing` tool in `lib/breezeAgent.js` calling the above
- System prompt addition for tight briefing format
- "📋 Daily briefing" quick-action button in ChatHome that sends
  a canned prompt to trigger the tool
- ADR amendment if the prompt-design experiment reveals
  structural problems with the signal set

No schema changes for v1. No cron, no email, no Cliq. Just chat.

## Alternatives considered

### A. Email-only digest (no chat involvement)
Owners get a daily email; that's it. Simpler to ship; loses the
"follow up by typing" benefit; doesn't reuse our chat surface.
Could be a v3 delivery channel layered on top of the chat-first
v1.

### B. Dashboard-only ("today" panel)
Add a "Today" panel on the Dashboard with the same signal list,
no LLM. Cheaper, more deterministic. Loses the narrative
prioritization that makes the briefing scannable. Could
co-exist with the LLM-driven version — Dashboard panel for
the visual scan, chat for the deeper read.

### C. Push notifications only
Headline-only via push: "3 emergencies, 1 renewal due, $12k
past due — open Breeze to see." Doesn't carry enough signal
for the user to triage from the notification itself; they have
to open the app anyway. Could complement v1.

### D. Don't build it
Status quo. Users keep clicking through six surfaces. Acceptable
if the dashboard + per-page surfaces are enough. The fact that
the user explicitly asked for this suggests they aren't.

## Revisit when

- v1 ships and we observe whether owners actually use the
  briefing button.
- Schema gains a timezone-per-user field → enables v3 cron with
  per-user local time.
- We add a notifications-preferences table → enables the
  per-owner-per-channel subscription model in v3.
- Cost forecast for v3 exceeds budget → reconsider Sonnet vs
  Haiku or a hybrid (Sonnet for the priority sorting, Haiku for
  the rendering).
