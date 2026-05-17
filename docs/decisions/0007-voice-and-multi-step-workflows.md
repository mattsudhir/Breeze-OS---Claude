# 0007. Voice control + multi-step workflow macros

**Status:** Proposed
**Date:** 2026-05-17
**Deciders:** mattsudhir + Claude (this session)

## Context

Today the chat agent is a one-shot Q&A loop: user says something,
LLM picks a tool, tool runs, LLM writes a sentence back. That works
for "how many tenants?" but breaks down for the requests a property
manager actually makes by voice:

> "Switch utilities into our name for 524 Nova."

That's not one tool call — it's a workflow:

1. Resolve "524 Nova" → a property record
2. Look up which utility providers serve that property (electric + gas)
3. Create a move event marking LL takeover
4. Queue a human task per utility ("Call ToledoEdison to flip 524 Nova
   to Breeze name")
5. Optionally dispatch the outbound calls via Vapi
6. When each call completes, update the corresponding task,
   record the changeover date, and notify the team

A second related gap: today voice → STT → chat lands the user in the
chat surface no matter what they said. "Show me 524 Nova" should
navigate to the property page, not narrate a summary in chat.

The user articulated both needs in one message:

> "Can the menu items all be called by voice? We should be able to
> say things like 'switch utilities into our name for 524 Nova' and
> the system should know to add the tasks for the electric and gas
> change overs, make the phone calls, and update the system once
> the calls are complete."

## Decision

Three layers, shipped together because they share the same agent
plumbing:

1. **Macro tools** — one tool per coherent workflow, each one
   wrapping the multi-step orchestration in a transaction. The
   first macro is `start_utility_changeover`. Others (turnover,
   move-out, list-vacant-unit) follow the same shape.

2. **Vapi callback closer** — `api/vapi-webhook.js` already
   receives call-completion events; today they go to logs. Wire it
   to update the originating `human_task` and emit a notification
   so the user knows the call's done. Vapi assistant config now
   carries a `correlation_id` (the human_task id) round-tripped in
   `assistant.metadata` so the webhook knows which task to close.

3. **Voice navigation tool** — `navigate_to_page` returns a
   structured `{type: "navigate", route: "/properties/<id>"}`
   directive. Chat UI listens, pushes the route. Chat-by-voice
   becomes app-control-by-voice without a separate router.

All three respect the existing approval-queue / autonomy-threshold
model from `lib/agentAudit.js`. Outbound calls in particular flow
through the staged-then-confirmed path described below.

## Macro tool: `start_utility_changeover`

Input:
```json
{
  "property_query": "524 Nova",
  "utility_types": ["electric", "gas"],   // optional; defaults to all the property has configured
  "auto_dispatch": false                    // optional; if true and approved, fires calls immediately
}
```

What it does in one transaction:
1. Property fuzzy match (free-text → property_id). On ambiguity,
   return `{candidates: [...]}` so chat can disambiguate with the
   user.
2. Pull `property_utilities` rows for that property → list of
   (utility_type, provider, current_holder).
3. Insert one `move_events` row of type `landlord_takeover`.
4. For each utility flip needed, insert one `human_tasks` row
   ("Call <provider> to switch <property>'s <utility_type> to
   Breeze name").
5. Return `{move_event_id, tasks: [...], summary, requires_approval}`.

If `auto_dispatch=true` AND the user is above the call autonomy
threshold, dispatch `make_call` per task in the same response,
attaching the task id as Vapi `metadata.correlation_id`.

Below threshold (default): chat replies with the staged plan
("Ready to call ToledoEdison + Columbia Gas — go?"). User confirms
in chat or via an approval-queue notification.

## Vapi callback closer

Extend `api/vapi-webhook.js`:
- Read `event.assistant.metadata.correlation_id`
- Look up the corresponding `human_task`
- On `call.status === 'completed'`: set task status `done`,
  attach the call transcript + recording URL as evidence,
  set the changeover date on `property_utilities` if applicable.
- On `call.status === 'failed'`: set task status `needs_followup`,
  notify the user.
- Emit a `notifications` row so the user sees "Call to ToledoEdison
  completed. Account flipped, effective Tuesday."

The webhook is already best-effort and signature-verified; this
just adds the metadata round-trip + the task close.

## Voice navigation tool

New `navigate_to_page` common tool:
```json
{
  "name": "navigate_to_page",
  "input_schema": {
    "type": "object",
    "properties": {
      "page": { "type": "string", "enum": ["properties", "tenants",
                  "maintenance", "leasing", "accounting", "reports",
                  "messaging", "dashboard"] },
      "id": { "type": "string", "description": "Optional record id for detail pages" },
      "filters": { "type": "object", "description": "Optional page-specific filters" }
    },
    "required": ["page"]
  }
}
```

The tool just returns the directive — it doesn't render anything.
The chat UI (`ChatHome.jsx`) listens for tool results of shape
`{type: "navigate", ...}` and calls `router.push(route)`. Routing
table lives in chat-ui code, not in the agent prompt, so we can
add routes without re-prompting.

## Autonomy + safety

Outbound calls have customer-trust + money-loss risk. Default
posture:

- **Resolving + planning + staging** — fully autonomous, no
  confirmation. The agent can look up properties, create move
  events, and queue tasks all day.
- **Outbound calls (make_call)** — require explicit user
  confirmation per call by default. The existing autonomy threshold
  (`lib/agentAudit.js`) can opt in to auto-dispatch for trusted
  workflows once we've built confidence.

Calling the wrong provider about the wrong property is a hard
reputation hit. The 1-second "Approve?" tap is cheap.

## Consequences

- Macro tools become a pattern. The next ones (turnover dispatch,
  move-out checklist kickoff, market-and-list) follow the same
  shape: resolve → stage rows → optionally dispatch → return
  structured plan.
- Vapi calls now carry workflow context, not just a `purpose`
  string. Future extensions (call retry, escalation, multi-leg)
  hang off the same `metadata.correlation_id`.
- Voice becomes a first-class app-control surface, not just a chat
  surface. Once `navigate_to_page` is in, every screen is
  voice-reachable.

## Alternatives considered

- **A workflow DSL** (BPMN-style state machine for changeovers,
  move-outs, etc.). Powerful but introduces an authoring problem —
  someone has to draw the diagram. Macros-as-functions are good
  enough and live in code where they're already audited.
- **Direct Vapi-to-task automation without LLM in the loop**. Faster
  but less flexible — the user couldn't say "switch utilities" in
  one sentence and have the system reason about which utilities the
  property has. The LLM is the planner; the macro is the executor.
- **Voice-only navigation via separate STT route** (push-to-talk
  reads command, routes directly). Reliable but a separate codepath
  to maintain. Folding into the existing chat agent is one mental
  model.

## Related ADRs

- 0005 (daily briefing) — the briefing tool is itself a macro-shaped
  workflow (resolve scope → pull signals → format). The pattern is
  consistent.
- 0006 (chat_metrics) — the metric reader gets called inside macros
  too ("how many vacant units before I list this one?") without
  paying the AppFolio scan cost.
