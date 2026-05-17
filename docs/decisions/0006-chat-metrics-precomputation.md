# 0006. Chat-metric pre-computation + invalidation

**Status:** Accepted (v1 shipping 2026-05-17, first wave of metrics)
**Date:** 2026-05-17
**Deciders:** mattsudhir + Claude (this session)

## Context

Chat is slow. Not because of the model — because every "how many X"
question round-trips through the agent loop:

1. LLM call (Haiku, ~1s)
2. Tool dispatch picks `count_tenants` / `count_work_orders` / etc.
3. Tool paginates AppFolio (1-3s per page; 5-15s for portfolios our size)
4. LLM gets a JSON blob back and writes a one-line answer (~1s)

A two-tool follow-up ("…and how many of them are delinquent?") doubles
that. Users see "Thinking…" for 10-30 seconds for questions whose
answer hasn't meaningfully changed in the last 15 minutes.

The user gave this list of the questions their team will actually ask
(verbatim):

> how many urgent tickets do we have, how many HVAC tickets do we have,
> how many tickets are more than thirty days old, how many tenants are
> nagging about tickets, how much rent did we receive today, what is
> the cumulative delinquency, how many tenants are delinquent, how much
> does x y z tenant owe, when was the last payment that x y z tenant
> made, is x y z tenant on a payment plan

These all share a property: the right answer can be computed once and
read many times. None of them genuinely needs to round-trip to AppFolio
on every chat keystroke.

## Decision

Pre-materialize answers in a `chat_metrics` table. The chat agent
reads from there in O(1). Keep the table fresh with a hybrid of:

1. **AppFolio webhook invalidation** — when AppFolio tells us
   `tenants/update`, mark the tenant-derived metrics dirty.
2. **5-minute cron sweep** — recompute any metric marked dirty.
3. **Hourly full recompute** — belt-and-suspenders against missed
   webhooks and dirty-mark map bugs.
4. **Stale-then-compute on read** — if a chat reads a metric that's
   missing or past its hard-staleness budget, the read does a live
   recompute synchronously, returns, AND enqueues the dirty-mark so
   the cron picks it up next time.

This piggybacks on infrastructure we already have. AppFolio webhooks
are subscribed (`api/webhooks/appfolio.js`) and already drive
`appfolio_cache` mirror upserts. The hourly reconcile cron
(`api/cron/appfolio-reconcile.js`) catches webhook drops at the
mirror level. We're just adding one more layer: turn mirror rows
into pre-aggregated answers.

## Why not pure webhook (no cron)?

AppFolio's docs explicitly don't promise exactly-once delivery. A
dropped webhook silently rots the cache, and you don't find out
until a user notices a stale count. The hourly recompute exists to
notice for you.

## Why not pure cron-every-5-min (no webhook)?

Wastes compute (recomputing metrics that nothing changed), and means
"new ticket count" stays stale for up to 5 minutes after a webhook
told us the answer changed. Webhook-driven invalidation is free —
the receiver is already doing the upsert.

## Why not just cache the AppFolio response?

That cache invalidation problem is unsolved at our edge — we wouldn't
know when to expire entries. Driving invalidation from the AppFolio
event stream (which IS authoritative about "data changed") gets us
correctness without a TTL guess.

## Schema

```sql
CREATE TABLE chat_metrics (
  organization_id   uuid REFERENCES organizations(id),
  metric_key        text NOT NULL,        -- e.g. 'tenant_count'
  scope_type        text NOT NULL,        -- 'org' | 'tenant' | 'property' | 'unit' | ...
  scope_id          text NOT NULL,        -- the scoped id, or '' for scope_type='org'
  value             jsonb NOT NULL,       -- shape depends on metric_key
  computed_at       timestamptz NOT NULL,
  stale             boolean NOT NULL DEFAULT false,
  dirty_at          timestamptz,          -- when it was last marked dirty
  PRIMARY KEY (organization_id, metric_key, scope_type, scope_id)
);
```

`scope_id` is text (not uuid) because some scopes will key on a
tenant's AppFolio id (string) and others on a Breeze uuid. `''` for
org-scoped metrics rather than NULL so the primary key has no nullable
columns (cleaner upserts).

## Metric registry

A central registry (`lib/chatMetrics/registry.js`) holds one entry per
metric_key:

```js
{
  key: 'tenant_count',
  scopeType: 'org',
  dependsOn: ['tenants'],         // webhook topics that invalidate it
  ttlSeconds: 3600,               // hard-staleness budget for read-time fallback
  compute: async (db, orgId) => ({
    total: 2215, active: 2128, hidden: 87,
  }),
}
```

`dependsOn` is the link between AppFolio webhook topics and dirty
marks. When `api/webhooks/appfolio.js` finishes upserting after a
`tenants/update`, it calls `markDirty('tenants')` which dirties every
metric whose `dependsOn` includes that topic.

For per-tenant / per-property metrics (`tenant_balance_cents`,
`tenant_last_payment_date`, etc.), the registry computer takes a
`scopeId` and the dirty-mark from a webhook event uses the webhook's
`resource_id` to dirty only the one row, not the whole metric_key.

## Cadence

| Signal class | Volatility | Refresh trigger |
|---|---|---|
| `tenant_count`, `property_count`, `unit_count` | days | webhook + 1h sweep |
| `occupancy_pct`, `vacant_unit_count` | hours | webhook + 15m sweep |
| `open_maint_count`, `urgent_maint_count`, `maint_by_category` | minutes | webhook + 5m sweep |
| `stale_maint_count` (>30 days) | hours (it's a date threshold) | 1h sweep |
| `delinquent_tenant_count`, `total_delinquency_cents` | hours | webhook + 15m sweep |
| `tenant_balance_cents` (per tenant) | hours | webhook on charges/tenants |
| `rent_received_today_cents` | minutes | webhook on charges + 5m sweep |
| `pending_approvals`, `reconcile_queue` | seconds | always live, never cache |

The 5-minute cron piggybacks on `api/cron/process-tasks` (already
running every 5 minutes per `vercel.json`) — we add a new
`api/cron/refresh-chat-metrics` and schedule it independently for
clarity.

## Question reframing — "how many tenants?"

User noted mid-implementation:

> "How many tenants do we have?" is almost always really "how many
> occupied units do we have?". A property manager cares about
> occupancy, not tenant-record count.

So the agent surface treats "how many tenants" as the wrong question
to answer literally. The system prompt instructs the agent to reach
for `occupancy_pct` (which returns `{pct, active_tenants,
rentable_units}`) and phrase the answer as "X tenancies out of Y
units (Z%)". The raw `tenant_count` metric is reserved for explicit
questions about tenant RECORDS ("how big is our tenant database").

This is a chat-layer / prompt decision, not a schema one — both
metrics exist; the prompt picks the right framing.

## What ships in v1

**Org-scoped (read from `appfolio_cache`):**
- `tenant_count`, `property_count`, `unit_count`, `occupancy_pct`,
  `vacant_unit_count`, `open_maint_count`, `urgent_maint_count`,
  `stale_maint_count`, `maint_by_category`,
  `delinquent_tenant_count`, `total_delinquency_cents`.

**Per-tenant scoped:**
- `tenant_balance_cents`, `tenant_lease_summary`.

**Read surface:**
- Chat: new `get_chat_metric` tool wired into both common-tools and
  the system prompt. The agent reaches for this BEFORE the slow
  `count_*` tools.
- Admin: `GET /api/admin/chat-metrics` lists every cached metric
  with its computed_at, stale flag, and value. `POST` triggers a
  recompute on demand (single key or all).

## Deferred to v1.1 / v2

- **Payments / receipts metrics** (`rent_received_today_cents`,
  `tenant_last_payment_date`): need either a receipts mirror or a
  scheduled pull from AppFolio's Income Register report. Not in v1
  because we don't have a receipts webhook topic from AppFolio.
- **Payment plans** (`tenant_on_payment_plan`): no source table yet
  — Breeze-native concept TBD.
- **"Nagging" detection** (tenants who follow up multiple times on a
  ticket): needs message-thread analysis on `maintenance_ticket_comments`.
  Computable but more thought required on the threshold (≥3 tenant
  comments in 7 days?).

These are tracked here so the next iteration has a clear punch list.

### User-defined custom metrics (idea captured 2026-05-17)

> "Maybe the user has custom questions that they want to add to the
> cache list. The process: first Breeze decides if it's a question it
> can answer, and if it is, it adds it to the cache list going forward
> — maybe even with an interval for how often it looks into this."
> — user, mid-implementation of v1.

The shape we want:

1. User types a question in chat or in a "Pin this question" UI.
2. Breeze runs it once live (the slow path) to confirm it's
   answerable and to record the answer shape.
3. If answerable, Breeze proposes:
   - A `metric_key` derived from the question
   - A `dependsOn` set of webhook topics (LLM-inferred from which
     mirror tables the live query touched)
   - A suggested refresh interval based on the inferred volatility
     class above
   - A scope (org / per-tenant / per-property)
4. User confirms (one click), and it goes into `chat_metrics` as a
   user-defined metric. Future asks of the same question read the
   cache.

Implementation notes for when we pick this up:
- Add a `user_defined` boolean to the registry row + a `created_by`
  actor_id column to `chat_metrics`.
- The compute function for a user-defined metric is the question
  text plus the captured query plan — Breeze re-runs the same chain
  on the cron interval.
- The dependsOn inference is the trickiest piece. v1 of this feature
  could just default to the hourly sweep for anything user-defined
  and let users explicitly opt-in to webhook invalidation if they
  know what they're doing.
- UI: a "Pinned questions" section on ChatHome that surfaces these
  with their last-computed time, so users see freshness at a glance
  and can re-pin/un-pin.

Not building this in the current PR — but the v1 table schema
intentionally has no columns that would block it (no NOT NULL
columns specific to system-defined metrics, scope_type/scope_id
already arbitrary text).

## Trade-offs we accept

- **Eventual consistency.** A metric can be up to 5 minutes stale
  between the AppFolio data change and the chat read. For the
  questions in scope (counts, balances, aggregates) this is fine.
  Anything that needs second-level freshness stays as a live query
  and isn't a chat_metric.
- **Registry maintenance burden.** Adding a new metric means adding
  to `lib/chatMetrics/registry.js` AND remembering to map its
  `dependsOn` topics. The hourly full sweep is the safety net for
  forgotten dependsOn entries.
- **Two sources of truth in the agent surface.** During the
  transition, `count_tenants` (AppFolio scan) and
  `get_chat_metric('tenant_count')` (cache read) both exist. The
  system prompt routes the agent to the cache first; the AppFolio
  scan stays as a fallback for metrics not yet pre-computed.

## Related ADRs

- 0001 (data source strategy) — chat_metrics reads from our DB, not
  from AppFolio directly. Consistent with "read from us, write
  AppFolio-first".
- 0003 (cache vs source-of-truth labels) — `chat_metrics` is
  A-CACHE-DERIVED: every value is recomputable from the source-of-
  truth mirror, safe to truncate at any time.
- 0005 (daily briefing) — the briefing data collector
  (`api/admin/daily-briefing-data`) is itself a candidate for
  becoming a chat_metric (or several) in a future pass.
